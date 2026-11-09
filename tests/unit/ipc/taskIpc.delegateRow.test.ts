import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const sessionState = vi.hoisted(() => ({
  getSession: vi.fn(),
  addMessageToSession: vi.fn(),
  updateMessage: vi.fn(),
}));

const orchestratorState = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {
    sendMessage = (...args: unknown[]) => orchestratorState.sendMessage(...args);
    cancel = (...args: unknown[]) => orchestratorState.cancel(...args);
    setSessionId = vi.fn();
    setPlanningService = vi.fn();
    setMessages = vi.fn();
    setWorkingDirectory = vi.fn();
    setWorkspaceScopeAuthority = vi.fn();
    getMessages = vi.fn(() => []);
  },
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
  broadcastToRenderer: vi.fn(),
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionState,
  notificationService: {
    notifyNeedsInput: vi.fn(),
    notifyTaskComplete: vi.fn(),
  },
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionState,
}));

vi.mock('../../../src/host/task/backgroundTaskSessionContext', () => ({
  getBackgroundTaskSessionContext: (sessionId: string) => sessionState.getSession(sessionId),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));

import { registerTaskHandlers } from '../../../src/host/ipc/task.ipc';
import { TaskManager } from '../../../src/host/task/TaskManager';

type DomainHandler = (_event: unknown, request: IPCRequest) => Promise<IPCResponse>;

function makeFakeIpc(): { handle: Mock; getHandler: () => DomainHandler } {
  const handlers = new Map<string, DomainHandler>();
  const handle = vi.fn((channel: string, handler: DomainHandler) => {
    handlers.set(channel, handler);
  });
  return {
    handle,
    getHandler: () => {
      const handler = handlers.get(IPC_DOMAINS.TASK);
      if (!handler) throw new Error('TASK handler not registered');
      return handler;
    },
  };
}

describe('task.ipc — real delegate_task row stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.getSession.mockResolvedValue({ messages: [], workingDirectory: '/tmp' });
  });

  it('stops only the addressed real TaskManager background run', async () => {
    let finishRun: (() => void) | undefined;
    orchestratorState.sendMessage.mockImplementation(() => new Promise<void>((resolve) => {
      finishRun = resolve;
    }));
    orchestratorState.cancel.mockResolvedValue(undefined);

    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
    const rowId = 'delegate-row-stop-real-shape';
    const run = manager.startBackgroundTask(rowId, 'session-row-stop', 'keep running');
    await vi.waitFor(() => expect(orchestratorState.sendMessage).toHaveBeenCalledOnce());

    const ipc = makeFakeIpc();
    registerTaskHandlers(ipc as never, () => manager);
    const response = await ipc.getHandler()({}, {
      action: 'cancelBackgroundTask',
      payload: { taskId: rowId },
    });
    const state = manager.getBackgroundTaskState(rowId);
    process.stdout.write(`${JSON.stringify({
      rowId,
      cancelled: (response.data as { cancelled?: boolean } | undefined)?.cancelled,
      managerStatus: state?.status,
      cancelCalls: orchestratorState.cancel.mock.calls.length,
    })}\n`);

    expect(response).toEqual({ success: true, data: { cancelled: true } });
    expect(state).toEqual({ sessionId: 'session-row-stop', status: 'cancelling' });
    expect(orchestratorState.cancel).toHaveBeenCalledOnce();

    finishRun?.();
    await run;
  });
});
