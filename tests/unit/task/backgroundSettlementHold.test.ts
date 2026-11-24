import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import { ModelRouter } from '../../../src/host/model/modelRouter';
import { SessionCommandCenter } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { getConfigService } from '../../../src/host/services/core/configService';
import Database from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { createLogger } from '../../../src/host/services/infra/logger';
import { getSessionManager } from '../../../src/host/services/infra/sessionManager';
import { notificationService } from '../../../src/host/services/infra/notificationService';
import { getBackgroundTaskManager } from '../../../src/host/session/backgroundTaskManager';
import { TaskManager } from '../../../src/host/task/TaskManager';
import {
  closeBackgroundRunAtTerminal,
  settleBackgroundOnTaskComplete,
  settleBackgroundRunOnRejection,
} from '../../../src/host/task/backgroundTaskTerminal';
import type { ModelResponse } from '../../../src/host/model/types';
import { createAgentRouter } from '../../../src/web/routes/agent';
import { createAgentLoop } from '../../../src/cli/bootstrap';

vi.unmock('better-sqlite3');
const h = vi.hoisted(() => ({
  info: vi.fn(),
  approvals: undefined as PendingApprovalRepository | undefined,
}));
vi.mock('../../../src/host/services/core/databaseService', async (original) => ({
  ...(await original<typeof import('../../../src/host/services/core/databaseService')>()),
  getDatabase: () => ({
    isReady: false,
    getSession: () => null,
    appendUsageRecord: vi.fn(),
    getPendingApprovalRepo: () => h.approvals,
  }),
}));
vi.mock('../../../src/cli/adapter', () => ({
  createCLIAgent: async () => ({
    getConfig: () => ({ modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' }, systemPrompt: '' }),
  }),
}));
vi.mock('../../../src/cli/bootstrap', async (original) => ({
  ...(await original<typeof import('../../../src/cli/bootstrap')>()),
  createAgentLoop: vi.fn(),
  createRunToolExecutor: vi.fn(() => undefined),
}));
vi.mock('../../../src/host/agent/orchestratorPermissions', async (original) => {
  const actual = await original<typeof import('../../../src/host/agent/orchestratorPermissions')>();
  return {
    ...actual,
    OrchestratorPermissionIsland: class extends actual.OrchestratorPermissionIsland {
      constructor(options: ConstructorParameters<typeof actual.OrchestratorPermissionIsland>[0]) {
        super({ ...options, injectedPendingApprovalRepo: options.injectedPendingApprovalRepo ?? h.approvals });
      }
    },
  };
});
vi.mock('../../../src/host/hooks/configParser', async (original) => ({
  ...(await original<typeof import('../../../src/host/hooks/configParser')>()),
  loadAllHooksConfig: async () => [],
}));
vi.mock('../../../src/host/services/infra/logger', async (original) => {
  const actual = await original<typeof import('../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: (tag: string) => tag === 'BackgroundSettlementHold'
      ? { info: h.info, warn: vi.fn() }
      : actual.createLogger(tag),
  };
});

const done: ModelResponse = { type: 'text', content: 'Scratch file task finished.', finishReason: 'stop' };
const toolCall = {
  id: 'scratch-file-check',
  name: 'Bash',
  arguments: { command: 'rm -- scratch.txt', description: 'Remove the disposable scratch file' },
};

describe('background settlement through the parent and delegated run entries', () => {
  const background = getBackgroundTaskManager();
  let db: Database.Database;
  let registry: RunRegistry;
  let center: SessionCommandCenter;
  let manager: TaskManager;
  let sessionId: string;
  let workspace: string;
  let parentRunId: string;
  let backgroundNotices: MockInstance<typeof notificationService.notifyTaskComplete>;
  let resumeModel: (response: ModelResponse) => void;
  const pendingModels: Array<(response: ModelResponse) => void> = [];

  beforeEach(async () => {
    h.info.mockClear();
    workspace = await mkdtemp(join(tmpdir(), 'neo-settlement-'));
    await writeFile(join(workspace, 'scratch.txt'), 'Disposable scratch file');
    vi.stubEnv('CODE_AGENT_DATA_DIR', workspace);
    vi.stubEnv('CODE_AGENT_MODEL_ENGINE', 'legacy');
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
    db = new Database(':memory:');
    applySchema(db, createLogger('SettlementFixtureSchema'));
    h.approvals = new PendingApprovalRepository(db);
    sessionId = randomUUID();
    const sessions = getSessionManager();
    vi.spyOn(sessions, 'getSession').mockResolvedValue({
      id: sessionId,
      title: 'Scratch file check',
      workingDirectory: workspace,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      todos: [],
      messageCount: 0,
    });
    vi.spyOn(sessions, 'addMessageToSession').mockResolvedValue(undefined);
    vi.spyOn(sessions, 'updateMessage').mockResolvedValue(undefined);
    vi.spyOn(sessions, 'updateSession').mockResolvedValue(undefined);
    backgroundNotices = vi.spyOn(notificationService, 'notifyTaskComplete').mockImplementation(() => undefined);
    registry = new RunRegistry();
    manager = new TaskManager();
    manager.initialize({ runRegistry: registry, configService: getConfigService(), onAgentEvent: vi.fn() });
    center = new SessionCommandCenter(manager, {
      projectTerminalResult: async () => undefined,
      wakeForegroundBrain: async () => undefined,
    });
    parentRunId = startPrimary();
  });

  afterEach(async () => {
    for (const finish of pendingModels.splice(0)) finish(done);
    for (const child of center?.active(sessionId) ?? []) await center.cancel(sessionId, child.id);
    center?.dispose();
    registry?.clear();
    db?.close();
    h.approvals = undefined;
    background.moveToForeground(sessionId);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true });
  });

  function startPrimary(): string {
    return registry.start({ sessionId, workspace }).context.runId;
  }

  async function spawn(parentId: string | null = parentRunId, response?: ModelResponse) {
    const inference = vi.spyOn(ModelRouter.prototype, 'inference');
    const model = Promise.withResolvers<ModelResponse>();
    resumeModel = model.resolve;
    pendingModels.push(resumeModel);
    let entered = false;
    inference.mockImplementationOnce(() => {
      entered = true;
      return model.promise;
    }).mockResolvedValue(done);
    const result = await center.spawn({
      sessionId,
      title: 'Check scratch file',
      shortName: 'Scratch check',
      laneKey: randomUUID(),
      submissionKey: randomUUID(),
      prompt: 'Check the disposable scratch file.',
      workspaceScope: createWorkspaceScope('scratch-project', [{
        sourceId: 'scratch-root', path: workspace, role: 'primary', access: 'read_write',
      }]),
      ...(parentId ? { parentRunId: parentId } : {}),
    });
    expect(result.outcome).toBe('started');
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 });
    if (response) resumeModel(response);
    return resumeModel;
  }

  async function closeParent(error?: string, runId = parentRunId) {
    await closeBackgroundRunAtTerminal(sessionId, 'agent_complete', new Map(error ? [[sessionId, { message: error }]] : []), runId);
    registry.unregister(runId);
  }

  function expectRunning() {
    expect(background.isTaskRunning(sessionId)).toBe(true);
    expect(backgroundNotices).not.toHaveBeenCalled();
  }

  async function expectCompletedOnce() {
    await vi.waitFor(() => expect(backgroundNotices).toHaveBeenCalledTimes(1));
    expect(background.getAllTasks().find((row) => row.sessionId === sessionId)?.status).toBe('completed');
  }

  async function waitForChild() {
    await vi.waitFor(() => expect(center.list(sessionId).map((child) => child.status)).toEqual(['completed']));
  }

  it('holds the parent and releases exactly one notice after the child', async () => {
    const finishFirst = await spawn();
    const finishLast = await spawn();
    await background.moveToBackground(sessionId);
    await closeParent();
    expectRunning();
    finishFirst(done);
    await vi.waitFor(() => expect(center.active(sessionId)).toHaveLength(1));
    expectRunning();
    finishLast(done);
    await expectCompletedOnce();
    expect(center.list(sessionId).map((child) => child.status)).toEqual(['completed', 'completed']);
  });

  it('keeps holding while a real child is waiting for approval', async () => {
    const approval = Promise.withResolvers<string>();
    const unobserve = manager.observeAgentEvents((_id, event) => {
      if (event.type === 'permission_request' && event.data?.id) approval.resolve(event.data.id);
    });
    try {
      await spawn(parentRunId, {
        type: 'tool_use', toolCalls: [toolCall], content: '', finishReason: 'tool_calls',
      });
      await background.moveToBackground(sessionId);
      await closeParent();
      await vi.waitFor(() => expect(h.approvals?.listByKindAndStatus('tool_approval', 'pending')).toHaveLength(1), { timeout: 5000 });
      const requestId = await approval.promise;
      expectRunning();
      expect(center.active(sessionId)).toHaveLength(1);
      expect(manager.handlePermissionResponse(sessionId, requestId, 'allow')).toBe('delivered');
      await expectCompletedOnce();
    } finally {
      unobserve();
    }
  });

  it('releases to the same run after a foreground and background round trip', async () => {
    await spawn(null);
    await background.moveToBackground(sessionId);
    await settleBackgroundOnTaskComplete(sessionId, sessionId, { summary: 'Checked', duration: 10 }, undefined, parentRunId);
    expectRunning();
    await closeParent();
    background.moveToForeground(sessionId);
    await background.moveToBackground(sessionId);
    expectRunning();
    resumeModel(done);
    await expectCompletedOnce();
    expect(backgroundNotices.mock.calls[0]?.[0]).toMatchObject({ summary: 'Checked', duration: 10 });
  });

  it('drops T1 failure when T2 succeeds in the foreground', async () => {
    await spawn();
    await background.moveToBackground(sessionId);
    await settleBackgroundRunOnRejection(sessionId, 'T1 failed', parentRunId);
    expectRunning();
    registry.unregister(parentRunId);
    background.moveToForeground(sessionId);
    const t2 = startPrimary();
    await closeParent(undefined, t2);
    resumeModel(done);
    await waitForChild();
    expect(backgroundNotices.mock.calls.some(([notice]) => notice.succeeded === false)).toBe(false);
    expect(background.isInBackground(sessionId)).toBe(false);
  });

  it('drops the stale hold before settling a later backgrounded T3', async () => {
    await spawn();
    await background.moveToBackground(sessionId);
    await closeParent('T1 failed');
    background.moveToForeground(sessionId);
    await closeParent(undefined, startPrimary());
    const t3 = startPrimary();
    await background.moveToBackground(sessionId);
    expect(h.info).toHaveBeenCalledWith('BACKGROUND_SETTLEMENT_DROPPED', {
      sessionId, runId: parentRunId, inFlightChildCount: 1,
    });
    resumeModel(done);
    await waitForChild();
    expectRunning();
    await closeParent(undefined, t3);
    await expectCompletedOnce();
  });

  it('settles immediately when the child has already ended', async () => {
    await spawn();
    resumeModel(done);
    await waitForChild();
    await background.moveToBackground(sessionId);
    await closeParent();
    await expectCompletedOnce();
    expect(h.info).not.toHaveBeenCalled();
  });

  it('gives a TaskManager parent and its registered loop the same run identity', async () => {
    registry.unregister(parentRunId);
    const parent = Promise.withResolvers<ModelResponse>();
    const inference = vi.spyOn(ModelRouter.prototype, 'inference').mockReturnValueOnce(parent.promise);
    const launched = manager.startTask(sessionId, 'Check the disposable scratch file.', undefined, {
      mode: 'normal', disableAutoAgent: true,
    });
    try {
      await vi.waitFor(() => expect(inference).toHaveBeenCalled(), { timeout: 5000 });
      const nativeRoot = registry.getBySessionId(sessionId);
      expect(nativeRoot).toBeDefined();
      const child = await spawn(nativeRoot?.context.runId);
      await background.moveToBackground(sessionId);
      parent.resolve(done);
      await launched;
      await manager.whenAgentEventsSettled(sessionId);
      expectRunning();
      expect(h.info).toHaveBeenCalledWith('BACKGROUND_SETTLEMENT_HELD', {
        sessionId, runId: nativeRoot?.context.runId, inFlightChildCount: 1,
      });
      child(done);
      await expectCompletedOnce();
      await waitForChild();
    } finally {
      parent.resolve(done);
      await launched;
    }
  });

  it('holds the real web run route until its real delegated child ends', async () => {
    registry.unregister(parentRunId);
    const parent = Promise.withResolvers<void>();
    const run = vi.fn(() => parent.promise);
    vi.mocked(createAgentLoop).mockReturnValue({ run, cancel: vi.fn(), steer: vi.fn() } as unknown as ReturnType<typeof createAgentLoop>);
    const sessions = getSessionManager();
    vi.spyOn(sessions, 'getMessages').mockResolvedValue([]);
    const app = express();
    app.use(express.json());
    app.use('/api', createAgentRouter({
      runRegistry: registry,
      pendingLocalToolCalls: new Map(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      tryGetSessionManager: async () => sessions,
      getSupabaseForSession: async () => null,
      getDurableRunRollout: () => ({
        policy: { mode: 'legacy', configuredValue: null, valid: true, durableActivation: false, durableReadPreference: false },
        ready: false,
      }),
    }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not open a TCP port');
    const response = fetch(`http://127.0.0.1:${address.port}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, prompt: 'Check the disposable scratch file', project: workspace }),
    }).then(async (res) => ({ status: res.status, body: await res.text() }));
    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalled());
      const webRunId = registry.getBySessionId(sessionId)?.context.runId;
      expect(webRunId).toBeDefined();
      await spawn(webRunId);
      await background.moveToBackground(sessionId);
      parent.resolve();
      expect(await response).toMatchObject({ status: 200, body: expect.stringContaining('event: agent_complete') });
      expectRunning();
      resumeModel(done);
      await expectCompletedOnce();
      await waitForChild();
    } finally {
      parent.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await response.catch(() => undefined);
    }
  });

  it('settles immediately when no child was delegated', async () => {
    await background.moveToBackground(sessionId);
    await closeParent();
    await expectCompletedOnce();
    expect(h.info).not.toHaveBeenCalled();
  });
});
