// A background delete whose rm was refused before any approval card must not settle "completed"
// while the named file is still on disk (N-FIX-BG-DELETE-SELF-REPORT-NOT-DELETED-MARKED-COMPLETED).
// TaskManager runs: only the model is scripted; the Bash call, the refusal, the run events and both
// settle entries (SessionCommandCenter.settle, closeBackgroundRunAtTerminal) are the real ones.
// Web runs: the real /api/run route settles a scripted loop that reports the rm's tool result.

import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AgentEvent, Message, ToolCall, ToolResult } from '../../../src/shared/contract';
import { BACKGROUND_TASK_DELETE_INCOMPLETE } from '../../../src/shared/constants';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import { ModelRouter } from '../../../src/host/model/modelRouter';
import type { ModelResponse } from '../../../src/host/model/types';
import { SessionCommandCenter } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { getConfigService } from '../../../src/host/services/core/configService';
import { getSessionManager } from '../../../src/host/services/infra/sessionManager';
import { notificationService } from '../../../src/host/services/infra/notificationService';
import { getBackgroundTaskManager } from '../../../src/host/session/backgroundTaskManager';
import { getBackgroundTaskLedger, resetBackgroundTaskLedgerForTest } from '../../../src/host/task/backgroundTaskLedger';
import { TaskManager } from '../../../src/host/task/TaskManager';
import { createAgentRouter } from '../../../src/web/routes/agent';
import { createAgentLoop } from '../../../src/cli/bootstrap';

vi.mock('../../../src/host/services/core/databaseService', async (original) => ({
  ...(await original<typeof import('../../../src/host/services/core/databaseService')>()),
  getDatabase: () => ({
    isReady: false,
    getSession: () => null,
    appendUsageRecord: vi.fn(),
    getPendingApprovalRepo: () => undefined,
  }),
}));
vi.mock('../../../src/host/hooks/configParser', async (original) => ({
  ...(await original<typeof import('../../../src/host/hooks/configParser')>()),
  loadAllHooksConfig: async () => [],
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

const RM_CALL_ID = 'call-refused-rm';
const REFUSALS = [
  // `rm -r` naming a path under /var is blocked by the lexical command-safety check on macOS and Linux.
  { guard: 'command safety', root: '/var/tmp', error: /^Security: Command blocked - Recursive deletion of a system directory$/ },
  // The captured a1 refusal: /tmp resolves into /private, which the permission classifier refuses.
  ...(process.platform === 'darwin'
    ? [{ guard: 'permission classifier', root: '/tmp', error: /^Denied: 危险命令: 递归删除关键路径 \/private\/tmp\// }]
    : []),
];
const notDeleted: ModelResponse = { type: 'text', content: '没删掉，两个文件还在原处。', finishReason: 'stop' };
const deleted: ModelResponse = { type: 'text', content: '两个旧缓存都已删除。', finishReason: 'stop' };

describe.each(REFUSALS)('a delete whose rm was refused before approval by the $guard', ({ root, error }) => {
  const background = getBackgroundTaskManager();
  let registry: RunRegistry;
  let manager: TaskManager;
  let center: SessionCommandCenter;
  let sessionId: string;
  let workspace: string;
  let outside: string;
  let file: string;
  let dir: string;
  let notices: MockInstance<typeof notificationService.notifyTaskComplete>;
  let rmResults: ToolResult[];
  let unobserve: () => void;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'neo-refused-rm-ws-'));
    outside = await mkdtemp(join(root, 'neo-refused-rm-'));
    file = join(outside, 'old-report-cache-a1.tmp');
    dir = join(outside, 'old-report-cache-dir-a1');
    await writeFile(file, 'x\n');
    await mkdir(dir);
    vi.stubEnv('CODE_AGENT_DATA_DIR', workspace);
    vi.stubEnv('CODE_AGENT_MODEL_ENGINE', 'legacy');
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
    resetBackgroundTaskLedgerForTest();
    sessionId = randomUUID();
    const sessions = getSessionManager();
    vi.spyOn(sessions, 'getSession').mockResolvedValue({
      id: sessionId,
      title: '清理旧报表缓存',
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
    notices = vi.spyOn(notificationService, 'notifyTaskComplete').mockImplementation(() => undefined);
    registry = new RunRegistry();
    manager = new TaskManager();
    manager.initialize({ runRegistry: registry, configService: getConfigService(), onAgentEvent: vi.fn() });
    center = new SessionCommandCenter(manager, {
      projectTerminalResult: async () => undefined,
      wakeForegroundBrain: async () => undefined,
    });
    rmResults = [];
    unobserve = manager.observeAgentEvents((_sessionId, event: AgentEvent) => {
      if (event.type === 'tool_call_end' && event.data.toolCallId === RM_CALL_ID) rmResults.push(event.data);
    });
  });

  afterEach(async () => {
    unobserve();
    center.dispose();
    registry.clear();
    background.moveToForeground(sessionId);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  /** The model's single rm for both paths (the captured a1 shape), then the given final reply. */
  function scriptModel(final: () => Promise<ModelResponse>, gate?: Promise<void>) {
    return vi.spyOn(ModelRouter.prototype, 'inference')
      .mockImplementationOnce(async () => {
        await gate;
        return {
          type: 'tool_use',
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: RM_CALL_ID,
            name: 'Bash',
            arguments: { command: `rm -rfv ${file} ${dir}; echo "exit=$?"`, description: 'Delete both cache paths in one rm command' },
          }],
        };
      })
      .mockImplementationOnce(final)
      .mockResolvedValue(notDeleted);
  }

  function expectRefusedBeforeApproval(): void {
    expect(rmResults).toHaveLength(1);
    expect(rmResults[0]).toMatchObject({
      success: false,
      error: expect.stringMatching(error),
      metadata: expect.objectContaining({ executionStarted: false }),
    });
  }

  async function runDelegated(final: () => Promise<ModelResponse>) {
    scriptModel(final);
    const spawned = await center.spawn({
      sessionId,
      title: '帮我清理一下旧报表缓存',
      shortName: '交接',
      laneKey: randomUUID(),
      submissionKey: randomUUID(),
      prompt: '帮我清理一下旧报表缓存，用一条 rm 命令把两个旧缓存一起删掉，完成后告诉我。',
      workspaceScope: createWorkspaceScope('cache-project', [{
        sourceId: 'cache-root', path: workspace, role: 'primary', access: 'read_write',
      }]),
    });
    expect(spawned.outcome).toBe('started');
    await vi.waitFor(() => expect(center.active(sessionId)).toHaveLength(0), { timeout: 10_000 });
    await manager.whenAgentEventsSettled(sessionId);
    const [task] = center.list(sessionId);
    return { task, row: getBackgroundTaskLedger().getTask(task.id) };
  }

  async function runDesktopInBackground(final: () => Promise<ModelResponse>) {
    const moved = Promise.withResolvers<void>();
    const inference = scriptModel(final, moved.promise);
    const launched = manager.startTask(sessionId, '帮我清理一下旧报表缓存，用一条 rm 命令把两个旧缓存一起删掉，完成后告诉我。', undefined, {
      mode: 'normal', disableAutoAgent: true,
    });
    await vi.waitFor(() => expect(inference).toHaveBeenCalled(), { timeout: 10_000 });
    expect(await background.moveToBackground(sessionId)).toBe(true);
    moved.resolve();
    await launched;
    await manager.whenAgentEventsSettled(sessionId);
    await vi.waitFor(() => expect(background.getAllTasks().find((row) => row.sessionId === sessionId)?.status).not.toBe('running'));
    return background.getAllTasks().find((row) => row.sessionId === sessionId);
  }

  it('delegated task: the task row, the ledger row and the notice all say the delete did not happen', async () => {
    const { task, row } = await runDelegated(async () => notDeleted);
    expectRefusedBeforeApproval();
    expect(existsSync(file)).toBe(true);
    expect(task.status).toBe('failed');
    expect(task.leftoverPaths).toEqual([file]);
    expect(row).toMatchObject({
      status: 'failed',
      leftoverPaths: [file],
      failure: { reason: BACKGROUND_TASK_DELETE_INCOMPLETE },
    });
    await vi.waitFor(() => expect(notices).toHaveBeenCalledTimes(1));
    expect(notices).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, succeeded: false, code: BACKGROUND_TASK_DELETE_INCOMPLETE }),
      { force: true },
    );
  });

  it('delegated task: stays completed when a later step really deleted the file', async () => {
    const { task, row } = await runDelegated(async () => {
      await unlink(file);
      return deleted;
    });
    expectRefusedBeforeApproval();
    expect(existsSync(file)).toBe(false);
    expect(task.status).toBe('completed');
    expect(task.leftoverPaths).toBeUndefined();
    expect(row?.status).toBe('completed');
    await vi.waitFor(() => expect(notices).toHaveBeenCalledTimes(1));
    expect(notices.mock.calls[0]?.[0].succeeded).not.toBe(false);
  });

  it('desktop run moved to background: settles DELETE_INCOMPLETE at the terminal entry', async () => {
    const row = await runDesktopInBackground(async () => notDeleted);
    expectRefusedBeforeApproval();
    expect(existsSync(file)).toBe(true);
    expect(row).toMatchObject({
      status: 'failed',
      completionMessage: BACKGROUND_TASK_DELETE_INCOMPLETE,
      leftoverPaths: [file],
    });
    await vi.waitFor(() => expect(notices).toHaveBeenCalledTimes(1));
    expect(notices.mock.calls[0]?.[0]).toMatchObject({ succeeded: false, code: BACKGROUND_TASK_DELETE_INCOMPLETE });
  });

  it('desktop run moved to background: stays completed when a later step really deleted the file', async () => {
    const row = await runDesktopInBackground(async () => {
      await unlink(file);
      return deleted;
    });
    expectRefusedBeforeApproval();
    expect(existsSync(file)).toBe(false);
    expect(row?.status).toBe('completed');
    expect(row?.leftoverPaths).toBeUndefined();
    await vi.waitFor(() => expect(notices).toHaveBeenCalledTimes(1));
    expect(notices.mock.calls[0]?.[0].succeeded).not.toBe(false);
  });
});

describe('a web run moved to background whose rm ended with the file still on disk', () => {
  const background = getBackgroundTaskManager();
  let registry: RunRegistry;
  let sessionId: string;
  let workspace: string;
  let outside: string;
  let file: string;
  let notices: MockInstance<typeof notificationService.notifyTaskComplete>;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'neo-refused-rm-web-'));
    outside = await mkdtemp('/var/tmp/neo-refused-rm-web-');
    file = join(outside, 'old-report-cache-a1.tmp');
    await writeFile(file, 'x\n');
    vi.stubEnv('CODE_AGENT_DATA_DIR', workspace);
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
    sessionId = randomUUID();
    const sessions = getSessionManager();
    vi.spyOn(sessions, 'getSession').mockResolvedValue({
      id: sessionId,
      title: '清理旧报表缓存',
      workingDirectory: workspace,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      todos: [],
      messageCount: 0,
    });
    vi.spyOn(sessions, 'getMessages').mockResolvedValue([]);
    vi.spyOn(sessions, 'addMessageToSession').mockResolvedValue(undefined);
    vi.spyOn(sessions, 'updateMessage').mockResolvedValue(undefined);
    vi.spyOn(sessions, 'updateSession').mockResolvedValue(undefined);
    notices = vi.spyOn(notificationService, 'notifyTaskComplete').mockImplementation(() => undefined);
    registry = new RunRegistry();
  });

  afterEach(async () => {
    registry.clear();
    background.moveToForeground(sessionId);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  /**
   * The loop records the rm call, reports its result, then ends after the session went to background.
   * `sealed`: the call is handed to a background task the way sealBouncedToolCalls does it, with the
   * result in a tool message and no tool_call_end.
   */
  async function runWeb(result: Omit<ToolResult, 'toolCallId'>, beforeEnd?: () => Promise<void>, sealed = false) {
    const backgrounded = Promise.withResolvers<void>();
    const call: ToolCall = { id: RM_CALL_ID, name: 'Bash', arguments: { command: `rm -rfv ${file}; echo "exit=$?"` } };
    vi.mocked(createAgentLoop).mockImplementation((_config, onEvent, messages) => ({
      run: async () => {
        const assistant: Message = { id: randomUUID(), role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [call] };
        messages?.push(assistant);
        onEvent({ type: 'message', data: assistant });
        if (sealed) {
          const tool: Message = {
            id: randomUUID(), role: 'tool', content: '', timestamp: Date.now(), toolResults: [{ toolCallId: RM_CALL_ID, ...result }],
          };
          messages?.push(tool);
          onEvent({ type: 'message', data: tool });
        } else {
          onEvent({ type: 'tool_call_end', data: { toolCallId: RM_CALL_ID, ...result } });
        }
        await backgrounded.promise;
        await beforeEnd?.();
      },
      cancel: vi.fn(),
      steer: vi.fn(),
    }) as unknown as ReturnType<typeof createAgentLoop>);
    const sessions = getSessionManager();
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
      body: JSON.stringify({ sessionId, prompt: '帮我清理一下旧报表缓存，用一条 rm 命令删掉，完成后告诉我。', project: workspace }),
    }).then(async (res) => ({ status: res.status, body: await res.text() }));
    try {
      await vi.waitFor(() => expect(createAgentLoop).toHaveBeenCalled(), { timeout: 10_000 });
      expect(await background.moveToBackground(sessionId)).toBe(true);
      backgrounded.resolve();
      expect(await response).toMatchObject({ status: 200, body: expect.stringContaining('event: agent_complete') });
      await vi.waitFor(() => expect(background.getAllTasks().find((row) => row.sessionId === sessionId)?.status).not.toBe('running'));
      return background.getAllTasks().find((row) => row.sessionId === sessionId);
    } finally {
      backgrounded.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await response.catch(() => undefined);
    }
  }

  const classifierRefusal = {
    success: false,
    error: 'Denied: 危险命令: 递归删除关键路径 /private/var/tmp/old-report-cache-a1.tmp',
    metadata: {
      failureCode: 'permission-denied',
      hostReason: { code: 'PERMISSION_CLASSIFIER_DENIED', metadata: { toolName: 'bash' } },
      executionStarted: false,
    },
  };

  it('settles DELETE_INCOMPLETE when the refused rm left the file', async () => {
    const row = await runWeb(classifierRefusal);
    expect(existsSync(file)).toBe(true);
    expect(row).toMatchObject({ status: 'failed', completionMessage: BACKGROUND_TASK_DELETE_INCOMPLETE, leftoverPaths: [file] });
    await vi.waitFor(() => expect(notices).toHaveBeenCalledTimes(1));
    expect(notices.mock.calls[0]?.[0]).toMatchObject({ succeeded: false, code: BACKGROUND_TASK_DELETE_INCOMPLETE });
  });

  it('stays completed when a later step really deleted the file', async () => {
    const row = await runWeb(classifierRefusal, () => unlink(file));
    expect(row?.status).toBe('completed');
    expect(row?.leftoverPaths).toBeUndefined();
  });

  it('leaves an rm handed off to a background task to that task', async () => {
    const row = await runWeb({
      success: false,
      error: 'HANDED_OFF_TO_BACKGROUND',
      duration: 0,
      metadata: { skipped: true, bounced: true, code: 'HANDED_OFF_TO_BACKGROUND' },
    }, undefined, true);
    expect(existsSync(file)).toBe(true);
    expect(row?.status).toBe('completed');
    expect(row?.leftoverPaths).toBeUndefined();
  });
});
