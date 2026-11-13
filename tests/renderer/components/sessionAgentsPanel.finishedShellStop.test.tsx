// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CanUseToolFn, Logger, ToolContext } from '../../../src/host/protocol/tools';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

type DomainHandler = (_event: unknown, request: IPCRequest) => Promise<IPCResponse>;

const ipcState = vi.hoisted(() => ({
  taskHandler: null as DomainHandler | null,
}));

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

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));

const appState = {
  language: 'zh' as const,
  setWorkbenchCollapsed: vi.fn(),
  activeAgentId: null as string | null,
  pendingPermissionRequest: null as { resolved?: boolean; agentId?: string; runId?: string } | null,
  pendingPermissionSessionId: null as string | null,
  queuedPermissionRequests: {} as Record<string, Array<{ resolved?: boolean; agentId?: string; runId?: string }>>,
};

vi.mock('../../../src/renderer/stores/appStore', () => {
  const useAppStore = (selector: (state: typeof appState) => unknown) => selector(appState);
  useAppStore.getState = () => appState;
  return { useAppStore };
});

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn().mockResolvedValue([]),
    invokeDomain: async (domain: string, action: string, payload?: unknown) => {
      if (domain !== 'domain:task' || action !== 'cancelBackgroundTask') return null;
      const handler = ipcState.taskHandler;
      if (!handler) throw new Error('TASK handler not registered');
      const response = await handler({}, { action, payload });
      if (!response.success) {
        throw new Error(response.error?.message ?? `${domain}:${action} failed`);
      }
      return response.data;
    },
    isAvailable: () => false,
  },
}));

import { zh } from '../../../src/renderer/i18n/zh';
import { SessionAgentsPanel } from '../../../src/renderer/components/TaskPanel/SessionAgentsPanel';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';
import { registerTaskHandlers } from '../../../src/host/ipc/task.ipc';
import { bashModule } from '../../../src/host/tools/modules/shell/bash';
import {
  cleanupCompletedTasks,
  getBackgroundTask,
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

function makeFakeIpc(): { handle: Mock; getHandler: () => DomainHandler } {
  const registry = new Map<string, DomainHandler>();
  const handle = vi.fn((channel: string, handler: DomainHandler) => {
    registry.set(channel, handler);
  });
  return {
    handle,
    getHandler: () => {
      const handler = registry.get('domain:task');
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

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

describe('SessionAgentsPanel finished shell stop', () => {
  let tempDir: string;
  let originalDataDir: string | undefined;
  const startedTaskIds: string[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'session-agents-finished-shell-'));
    originalDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempDir, 'data');
    ipcState.taskHandler = null;
    logState.info.mockClear();
    resetBackgroundTaskEventAdaptersForTest();
    resetBackgroundTaskLedgerForTest();
    installBackgroundTaskEventAdapters(getBackgroundTaskLedger());
    useBackgroundTaskStore.setState({ tasks: [] });
    useSessionStore.setState({ sessions: [], currentSessionId: 'session-finished-shell' });
    useSwarmStore.setState({
      activeSessionId: undefined,
      activeRunId: undefined,
      activeTreeId: undefined,
      lastEventAt: undefined,
      eventLog: [],
      agents: [],
    });
    useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [], isLoaded: true });
    useMemberViewStore.setState({ viewingMemberId: null });
    useVoiceCallStore.getState().reset();
    appState.activeAgentId = null;
    appState.pendingPermissionRequest = null;
    appState.pendingPermissionSessionId = null;
    appState.queuedPermissionRequests = {};
  });

  afterEach(async () => {
    cleanup();
    for (const taskId of startedTaskIds.splice(0)) {
      const task = getBackgroundTask(taskId);
      if (task?.status === 'running') await killBackgroundTask(taskId);
    }
    cleanupCompletedTasks();
    ipcState.taskHandler = null;
    resetBackgroundTaskEventAdaptersForTest();
    resetBackgroundTaskLedgerForTest();
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('finished shell stop returns not_stopped through Task IPC and shows the already-ended hint', async () => {
    const handler = await bashModule.createHandler();
    const context: ToolContext = {
      sessionId: 'session-finished-shell',
      workingDir: tempDir,
      abortSignal: new AbortController().signal,
      logger: makeLogger(),
      emit: () => undefined,
      policyEnforcer: null,
      currentToolCallId: 'tool-finished-shell',
    };
    const allowAll: CanUseToolFn = async () => ({ allow: true });
    const started = await handler.execute({
      command: 'sleep 0',
      run_in_background: true,
      timeout: 600_000,
    }, context, allowAll);
    expect(started.ok).toBe(true);

    const taskId = started.ok && typeof started.meta?.taskId === 'string' ? started.meta.taskId : '';
    expect(taskId).not.toBe('');
    startedTaskIds.push(taskId);

    const shellFinished = await waitFor(
      () => getBackgroundTask(taskId)?.status !== 'running',
      5_000,
    );
    const ledger = getBackgroundTaskLedger();
    const rowId = `shell:${taskId}`;
    const rowFinished = await waitFor(
      () => ledger.getTask(rowId)?.status !== 'running',
      5_000,
    );
    const finishedShell = getBackgroundTask(taskId);
    const finishedLedgerRow = ledger.getTask(rowId);
    expect(shellFinished).toBe(true);
    expect(rowFinished).toBe(true);
    expect(finishedShell?.status).not.toBe('running');
    expect(finishedLedgerRow).toMatchObject({
      id: rowId,
      kind: 'shell',
      metadata: expect.objectContaining({ originalTaskId: taskId }),
    });

    const ipc = makeFakeIpc();
    registerTaskHandlers(ipc as never, () => null);
    ipcState.taskHandler = ipc.getHandler();
    const response = await ipcState.taskHandler({}, {
      action: 'cancelBackgroundTask',
      payload: { taskId: rowId },
    });
    expect(response).toMatchObject({ success: true, data: { cancelled: false } });
    const stopLog = logState.info.mock.calls.find(([message]) => message === 'Background task stop');
    expect(stopLog?.[1]).toMatchObject({
      taskId: rowId,
      outcome: 'not_stopped',
      cancelled: false,
    });
    process.stdout.write(`finished shell state: getBackgroundTask(${taskId}).status=${finishedShell?.status}; ledger row ${rowId}.status=${finishedLedgerRow?.status}\n`);
    process.stdout.write(`Background task stop call args ${inspect(stopLog?.[1], { depth: null })}\n`);

    if (!finishedLedgerRow) throw new Error('finished shell ledger row was not created');
    useBackgroundTaskStore.setState({
      tasks: [{ ...finishedLedgerRow, status: 'running' }],
    });

    render(<SessionAgentsPanel />);
    const stopButton = await screen.findByTestId(`agents-panel-stop-${rowId}`);
    fireEvent.click(stopButton);

    const hint = await screen.findByTestId(`agents-panel-stop-hint-${rowId}`);
    expect(hint.textContent).toContain(zh.expert.memberBar.panel.stopFailedHint);
    expect(hint.textContent).toContain('这个任务已经结束或无法停止');
    process.stdout.write(`renderer DOM assertion: agents-panel-stop-hint-${rowId} text=${JSON.stringify(hint.textContent)} contains 这个任务已经结束或无法停止\n`);
    await waitFor(() => !screen.queryByTestId(`agents-panel-stop-${rowId}`)?.hasAttribute('disabled'), 1_000);
  });
});
