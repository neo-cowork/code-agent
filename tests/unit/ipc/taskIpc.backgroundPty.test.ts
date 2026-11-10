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

// tests/setup.ts installs a node-pty fake with pid=0. This regression must prove
// that the task IPC route kills a real process. CI runners without a working PTY
// binary skip only this real-runtime proof; the normal IPC suite still covers its wiring.
async function probeRealPty(): Promise<boolean> {
  try {
    const realPty = await vi.importActual<typeof import('node-pty')>('node-pty');
    const probe = realPty.spawn('/bin/sh', ['-c', 'exit 0'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: tmpdir(),
      env: process.env as Record<string, string>,
    });
    const spawned = probe.pid > 0;
    try { probe.kill(); } catch { /* already exited */ }
    return spawned;
  } catch {
    return false;
  }
}

const realPtyAvailable = await probeRealPty();
if (realPtyAvailable) vi.doUnmock('node-pty');

const { registerTaskHandlers } = await import('../../../src/host/ipc/task.ipc');
const { bashModule } = await import('../../../src/host/tools/modules/shell/bash');
const {
  getAllPtySessions,
  getPtySession,
  killPtySession,
} = await import('../../../src/host/tools/shell/ptyExecutor');
const {
  installBackgroundTaskEventAdapters,
  resetBackgroundTaskEventAdaptersForTest,
} = await import('../../../src/host/task/backgroundTaskSnapshotAdapters');
const {
  getBackgroundTaskLedger,
  resetBackgroundTaskLedgerForTest,
} = await import('../../../src/host/task/backgroundTaskLedger');

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

describe.skipIf(!realPtyAvailable)('task.ipc — real background PTY row stop', () => {
  let tempDir: string;
  let originalDataDir: string | undefined;
  const startedSessionIds: string[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'task-ipc-background-pty-'));
    originalDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, 'data');
    logState.info.mockClear();
    resetBackgroundTaskEventAdaptersForTest();
    resetBackgroundTaskLedgerForTest();
    installBackgroundTaskEventAdapters(getBackgroundTaskLedger());
  });

  afterEach(async () => {
    for (const sessionId of startedSessionIds.splice(0)) {
      const session = getAllPtySessions().find((candidate) => candidate.sessionId === sessionId);
      if (session?.status === 'running') await killPtySession(sessionId);
    }
    resetBackgroundTaskEventAdaptersForTest();
    resetBackgroundTaskLedgerForTest();
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('real bashModule PTY background sleep 0 reaches the ledger as completed with empty output', async () => {
    const handler = await bashModule.createHandler();
    const sessionId = 'session-real-pty-exit';
    const started = await handler.execute({ command: 'sleep 0', run_in_background: true, pty: true }, {
      sessionId,
      workingDir: tempDir,
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
      emit: () => undefined,
      policyEnforcer: null,
      currentToolCallId: 'tool-real-pty-exit',
    }, async () => ({ allow: true }));
    expect(started.ok).toBe(true);
    const ptyId = started.ok && typeof started.meta?.sessionId === 'string' ? started.meta.sessionId : '';
    expect(ptyId).not.toBe('');
    startedSessionIds.push(ptyId);
    expect(getPtySession(ptyId)?.pty.pid).toBeGreaterThan(0);
    const ledger = getBackgroundTaskLedger();
    expect(await waitFor(() => ledger.getTask(`pty:${ptyId}`)?.status === 'completed', 5_000)).toBe(true);
    expect(getPtySession(ptyId)).toMatchObject({ status: 'completed', exitCode: 0 });
    const row = ledger.getTask(`pty:${ptyId}`);
    expect(row).toMatchObject({ status: 'completed', failure: undefined, outputRefs: [expect.objectContaining({ size: 0 })] });
    expect(ledger.drainNotifications(sessionId)).toEqual([
      expect.objectContaining({ taskId: row?.id, type: 'task_completed' }),
    ]);
    process.stdout.write(`${JSON.stringify({ ledgerId: row?.id, status: row?.status, exitCode: 0, failure: row?.failure ?? null, logSize: row?.outputRefs[0]?.size })}\n`);
  });

  it('kills a real Bash PTY background process when IPC receives its pty ledger row id', async () => {
    const handler = await bashModule.createHandler();
    const context: ToolContext = {
      sessionId: 'session-real-pty-stop',
      workingDir: tempDir,
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
      emit: () => undefined,
      policyEnforcer: null,
      currentToolCallId: 'tool-real-pty-stop',
    };
    const allowAll: CanUseToolFn = async () => ({ allow: true });

    const started = await handler.execute({
      command: 'sleep 600',
      run_in_background: true,
      pty: true,
      timeout: 600_000,
    }, context, allowAll);
    expect(started.ok).toBe(true);

    const sessionId = started.ok && typeof started.meta?.sessionId === 'string'
      ? started.meta.sessionId
      : '';
    expect(sessionId).not.toBe('');
    startedSessionIds.push(sessionId);

    const pid = getPtySession(sessionId)?.pty.pid;
    expect(pid, 'node-pty test fake leaked into the real-process regression').toBeGreaterThan(0);
    if (typeof pid !== 'number' || pid <= 0) throw new Error('real PTY process was not registered');

    const ledger = getBackgroundTaskLedger();
    const row = ledger.getTask(`pty:${sessionId}`);
    expect(row).toMatchObject({
      id: `pty:${sessionId}`,
      kind: 'pty',
      status: 'running',
      metadata: expect.objectContaining({ originalSessionId: sessionId }),
    });

    const ipc = makeFakeIpc();
    registerTaskHandlers(ipc as never, () => null);
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
      bareSessionId: sessionId,
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
