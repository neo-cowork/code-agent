import { EventEmitter } from 'events';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CanUseToolFn, Logger, ToolContext } from '../../../src/host/protocol/tools';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const logState = vi.hoisted(() => ({
  info: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: logState.info,
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { registerTaskHandlers } from '../../../src/host/ipc/task.ipc';
import { bashModule } from '../../../src/host/tools/modules/shell/bash';
import {
  cleanupCompletedTasks,
  getBackgroundTask,
  getAllBackgroundTasks,
  killBackgroundTask,
} from '../../../src/host/tools/shell/backgroundTasks';
import {
  installBackgroundTaskEventAdapters,
  resetBackgroundTaskEventAdaptersForTest,
} from '../../../src/host/task/backgroundTaskSnapshotAdapters';
import {
  getBackgroundTaskLedger,
  resetBackgroundTaskLedgerForTest,
} from '../../../src/host/task/backgroundTaskLedger';

type DomainHandler = (_event: unknown, request: IPCRequest) => Promise<IPCResponse>;

function makeFakeIpc(): { handle: Mock; getHandler: () => DomainHandler } {
  const registry = new Map<string, DomainHandler>();
  const handle = vi.fn((channel: string, handler: DomainHandler) => {
    registry.set(channel, handler);
  });
  return {
    handle,
    getHandler: () => {
      const handler = registry.get(IPC_DOMAINS.TASK);
      if (!handler) throw new Error('TASK handler not registered');
      return handler;
    },
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe('task.ipc — real background Bash row stop', () => {
  let tempDir: string;
  let originalDataDir: string | undefined;
  const startedTaskIds: string[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'task-ipc-background-shell-'));
    originalDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, 'data');
    logState.info.mockClear();
    resetBackgroundTaskEventAdaptersForTest();
    resetBackgroundTaskLedgerForTest();
    installBackgroundTaskEventAdapters(getBackgroundTaskLedger());
  });

  afterEach(async () => {
    for (const taskId of startedTaskIds.splice(0)) {
      const task = getBackgroundTask(taskId);
      if (task?.status === 'running') await killBackgroundTask(taskId);
    }
    cleanupCompletedTasks();
    resetBackgroundTaskEventAdaptersForTest();
    resetBackgroundTaskLedgerForTest();
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('kills a real Bash run_in_background process when IPC receives its shell ledger row id', async () => {
    const handler = await bashModule.createHandler();
    const context: ToolContext = {
      sessionId: 'session-real-shell-stop',
      workingDir: tempDir,
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
      emit: () => undefined,
      policyEnforcer: null,
      currentToolCallId: 'tool-real-shell-stop',
    };
    const allowAll: CanUseToolFn = async () => ({ allow: true });

    const started = await handler.execute({
      command: 'sleep 600',
      run_in_background: true,
      timeout: 600_000,
    }, context, allowAll);
    expect(started.ok).toBe(true);

    const taskId = started.ok && typeof started.meta?.taskId === 'string'
      ? started.meta.taskId
      : '';
    expect(taskId).not.toBe('');
    startedTaskIds.push(taskId);

    const shellTask = getAllBackgroundTasks().find((task) => task.taskId === taskId);
    const pid = getBackgroundTask(taskId)?.process.pid;
    expect(shellTask).toBeDefined();
    expect(pid).toBeTypeOf('number');
    if (!shellTask || typeof pid !== 'number') throw new Error('real shell process was not registered');

    const ledger = getBackgroundTaskLedger();
    const row = ledger.getTask(`shell:${taskId}`);
    expect(row).toMatchObject({
      id: `shell:${taskId}`,
      kind: 'shell',
      status: 'running',
      metadata: expect.objectContaining({ originalTaskId: taskId }),
    });

    const fakeManager = Object.assign(new EventEmitter(), {
      cancelBackgroundTask: vi.fn(async () => false),
    });
    const ipc = makeFakeIpc();
    registerTaskHandlers(ipc as never, () => fakeManager as never);
    const response = await ipc.getHandler()({}, {
      action: 'cancelBackgroundTask',
      payload: { taskId: row?.id },
    });
    const cancelled = (response.data as { cancelled?: boolean } | undefined)?.cancelled;
    const pidAliveAfterIpc = isPidAlive(pid);
    const pidGoneWithin5s = await waitFor(() => !isPidAlive(pid), 5_000);
    const rowLeftRunningWithin5s = await waitFor(() => ledger.getTask(row!.id)?.status !== 'running', 5_000);
    const ledgerStatus = ledger.getTask(row!.id)?.status;
    const stopLog = logState.info.mock.calls.find(([message]) => message === 'Background task stop');
    process.stdout.write(`${JSON.stringify({
      ledgerId: row?.id,
      bareTaskId: taskId,
      pid,
      cancelled,
      pidAliveAfterIpc,
      pidGoneWithin5s,
      rowLeftRunningWithin5s,
      ledgerStatus,
      stopLog,
    })}\n`);

    expect(response).toMatchObject({ success: true, data: { cancelled: true } });
    expect(pidGoneWithin5s).toBe(true);
    expect(rowLeftRunningWithin5s).toBe(true);
    expect(logState.info).toHaveBeenCalledWith(
      'Background task stop',
      expect.objectContaining({ taskId: row?.id, cancelled: true }),
    );
  });
});
