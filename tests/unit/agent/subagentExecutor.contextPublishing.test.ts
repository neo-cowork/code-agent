// ============================================================================
// 侧聊不得进会话的代理活动账（N-BTW-GUI-FLOATER r2 Gap 2）
// ----------------------------------------------------------------------------
// /btw 走真实 SubagentExecutor 时，emitContextSnapshot 默认会把运行记录
// upsert 进 subagentContextStore；agentTreeService 把这本账渲染成会话的代理
// 节点（状态 unknown → 面板口径「工作中」），右侧「专家」面板因此自动弹出并
// 滞留「system 工作中」行。侧聊是一次性问答，必须整条不注册：
// suppressContextPublishing 跳过 upsert，成功/失败/中止都没有东西要清理。
// 这里跑真实 executor + 真实 store（临时目录），断言口径直接对齐面板：
// buildAgentTreeSnapshot 的节点数（mergeContextRecord 的唯一入口）。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const contextStoreHolder = vi.hoisted(() => ({ instance: undefined as unknown }));

vi.mock('../../../src/host/context/subagentContextStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/context/subagentContextStore')>();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'sidechat-agent-activity-'));
  contextStoreHolder.instance = new actual.SubagentContextStore(nodePath.join(dir, 'store.json'));
  return {
    getSubagentContextStore: () => contextStoreHolder.instance,
    SubagentContextStore: actual.SubagentContextStore,
  };
});

const mocks = vi.hoisted(() => {
  const responses: Array<Record<string, unknown>> = [];
  const inference = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Missing mocked inference response');
    return response;
  });
  const pipelineContext = {
    agentId: 'pipeline-agent',
    permissionConfig: { blockedCommands: [] as string[] },
  };
  const pipeline = {
    createContext: vi.fn(() => pipelineContext),
    checkBudget: vi.fn(() => ({ allowed: true, warnings: [] as string[] })),
    checkToolExecution: vi.fn(() => ({ allowed: true })),
    completeContext: vi.fn(),
    getBudgetStatus: vi.fn(() => ({ subagentCost: 0 })),
    getRemainingBudget: vi.fn(() => undefined),
    recordTokenUsage: vi.fn(),
    recordToolUsage: vi.fn(),
  };
  const startTask = vi.fn();
  const observeAgentEvents = vi.fn<(observer: (
    sessionId: string,
    event: { type: string; data: { role: string; content: string } },
  ) => void) => () => void>(() => () => undefined);
  const getSessionState = vi.fn((): { status: 'idle' | 'running'; startTime?: number } => ({ status: 'idle' }));
  const executeTool = vi.fn(async () => ({ success: true, output: 'Read partial output' }));
  return { responses, inference, pipeline, pipelineContext, startTask, observeAgentEvents, getSessionState, executeTool };
});

vi.mock('../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {
    inference = mocks.inference;
  },
  PROVIDER_REGISTRY: {
    test: { models: [{ id: 'test-model', supportsTool: true }] },
  },
}));

vi.mock('../../../src/host/model/adapters/aiSdkAdapter', () => ({
  aiSdkSupportsProvider: () => false,
  inferenceViaAiSdk: vi.fn(),
}));

vi.mock('../../../src/host/agent/subagentPipeline', () => ({
  getSubagentPipeline: () => mocks.pipeline,
}));

vi.mock('../../../src/host/agent/subagentToolRuntime', () => ({
  createSubagentToolRuntime: () => ({
    executor: { execute: mocks.executeTool },
    policy: {},
  }),
}));

vi.mock('../../../src/host/agent/agentTask', () => ({
  AgentTask: class {
    id: string;
    appendTranscript = vi.fn();
    stop = vi.fn();
    fail = vi.fn();

    constructor(id: string) {
      this.id = id;
    }
  },
}));

vi.mock('../../../src/host/agent/subagentLifecycleHooks', () => ({
  startSubagentLifecycle: ({ context }: { context: { sessionId: string } }) => context.sessionId,
}));

vi.mock('../../../src/host/agent/subagentExecutionTracing', () => ({
  runSubagentExecutionWithTrace: (
    _request: unknown,
    run: () => Promise<unknown>,
  ) => run(),
}));

vi.mock('../../../src/host/agent/subagentExecutionRouter', () => ({
  routeExternalSubagentExecution: () => null,
}));

vi.mock('../../../src/host/testing/e2e/subagentE2ELocalExecutor', () => ({
  shouldUseE2ELocalSubagentExecutor: () => false,
  executeE2ELocalSubagent: vi.fn(),
}));

vi.mock('../../../src/host/agent/subagentFirstRunPreset', () => ({
  resolveSubagentPreset: async (preset: unknown) => preset,
}));

vi.mock('../../../src/host/agent/subagentProtocolContext', () => ({
  normalizeSubagentModelContext: (context: unknown) => context,
  resolveSubagentParentContext: () => ({ availableTools: [] }),
}));

vi.mock('../../../src/host/agent/childContext', () => ({
  checkReadonlyParentRule: () => ({ allowed: true }),
  buildChildContext: (child: { allowedTools: string[] }) => ({
    toolPool: child.allowedTools,
    permissions: {
      deny: [],
      blockedCommands: [],
      effectiveMode: 'default',
    },
  }),
}));

vi.mock('../../../src/host/agent/subagentExecutorCancellation', () => ({
  getChildSubagentExecutionTimeout: () => 60_000,
  getSubagentExecutionTimeout: () => 900_000,
  getSubagentIdleTimeout: () => 30_000,
  createSubagentCancellationLifecycle: () => {
    const controller = new AbortController();
    return {
      effectiveController: controller,
      effectiveSignal: controller.signal,
      cleanupTimer: vi.fn(),
      markProgress: vi.fn(),
      markRequestStart: vi.fn(),
      markRequestEnd: vi.fn(),
      markToolStart: vi.fn(),
      markToolEnd: vi.fn(),
      stopIdleWatchdog: vi.fn(),
    };
  },
}));

vi.mock('../../../src/host/context/contextInterventionState', () => ({
  getContextInterventionState: () => ({ getEffectiveSnapshot: () => ({}) }),
}));

vi.mock('../../../src/host/context/contextInterventionHelpers', () => ({
  applyInterventionsToMessages: (messages: unknown) => messages,
}));

vi.mock('../../../src/host/agent/subagentCompaction', () => ({
  compactSubagentMessages: () => false,
}));

vi.mock('../../../src/host/telemetry/telemetryCollector', () => ({
  getTelemetryCollector: () => ({ recordDetachedTurn: vi.fn() }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({ permissions: { inheritance: 'strict-inherit' } }),
  }),
}));

vi.mock('../../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: () => [],
  adoptOrphanTasks: vi.fn(),
}));

vi.mock('../../../src/host/services/roleAssets', () => ({
  buildRoleContextBlock: vi.fn(),
  runRoleWriteBack: vi.fn(),
  recordRoleParticipation: vi.fn(),
  applyRoleBoundaryToSubagentRequest: vi.fn((request: unknown) => request),
}));

vi.mock('../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => ({
    getSessionState: mocks.getSessionState,
    observeAgentEvents: mocks.observeAgentEvents,
    startTask: mocks.startTask,
  }),
}));

vi.mock('../../../src/host/agent/agentWorktree', () => ({
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(undefined),
  resolveAgentWorktreeIsolation: vi.fn().mockResolvedValue('none'),
}));

import { getBackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { executeSingleSpawnAgent } from '../../../src/host/agent/multiagentTools/spawnSingleAgent';
import { getSpawnGuard } from '../../../src/host/agent/spawnGuard';
import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';
import { buildAgentTreeSnapshot } from '../../../src/host/agent/agentTreeService';
import { getSubagentContextStore } from '../../../src/host/context/subagentContextStore';

const SIDE_CHAT_SESSION = 'side-chat-session';
const ORDINARY_SESSION = 'ordinary-session';

function textResponse(content: string) {
  return {
    type: 'text',
    content,
    usage: { inputTokens: 4, outputTokens: 5 },
  };
}

/** sideChat.ipc.ts 构造的 baseContext 同形（含 r2 的 suppressContextPublishing）。 */
function sideChatRequest(sessionId = SIDE_CHAT_SESSION) {
  return {
    prompt: '顺便问一句',
    config: {
      name: 'side-chat',
      systemPrompt: '你是一个只读侧聊助手。',
      availableTools: [],
    },
    context: {
      sessionId,
      cwd: '/tmp/work',
      modelConfig: { provider: 'test', model: 'test-model' },
      resolver: { getDefinition: () => undefined },
      permission: { request: async () => false },
      events: { emit() { /* side chat does not touch the main conversation stream */ } },
      abortSignal: new AbortController().signal,
      suppressContextPublishing: true,
    },
  };
}

/** 面板口径的「工作中」数：agentTree 快照里 running/queued/paused/unknown 节点数。 */
function workingAgentCount(sessionId: string): number {
  const snapshot = buildAgentTreeSnapshot({
    now: Date.now(),
    sessionId,
    contextRecords: getSubagentContextStore().list(sessionId),
    spawnAgents: [],
    parallelTasks: [],
    backgroundAgents: [],
    worktrees: [],
    ownershipConflicts: [],
  });
  return snapshot.nodes.filter((node) => ['running', 'queued', 'paused', 'unknown'].includes(node.status)).length;
}

describe('SubagentExecutor context publishing (side chat stays out of agent activity)', () => {
  beforeEach(() => {
    mocks.responses.length = 0;
    vi.clearAllMocks();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });

  afterEach(() => {
    delete process.env.CODE_AGENT_MODEL_ENGINE;
  });

  it('still publishes context records for ordinary subagents (unchanged default)', async () => {
    mocks.responses.push(textResponse('普通子代理的回答'));
    const request = sideChatRequest(ORDINARY_SESSION);
    delete (request.context as Record<string, unknown>).suppressContextPublishing;
    request.config = { name: 'ordinary-agent', systemPrompt: '普通子代理。', availableTools: [] };

    const result = await new SubagentExecutor().execute(request);

    expect(result).toMatchObject({ success: true, output: '普通子代理的回答' });
    expect(getSubagentContextStore().list(ORDINARY_SESSION).length).toBeGreaterThan(0);
    expect(workingAgentCount(ORDINARY_SESSION)).toBeGreaterThan(0);
  });

  it('does not change the working-agents count the panel reads for a side-chat run', async () => {
    const before = workingAgentCount(SIDE_CHAT_SESSION);
    mocks.responses.push(textResponse('侧聊答案'));

    const result = await new SubagentExecutor().execute(sideChatRequest());

    expect(result).toMatchObject({ success: true, output: '侧聊答案' });
    expect(getSubagentContextStore().list(SIDE_CHAT_SESSION)).toHaveLength(0);
    expect(workingAgentCount(SIDE_CHAT_SESSION)).toBe(before);
  });

  it('leaves nothing running after a failed side chat, including a retry', async () => {
    mocks.inference.mockRejectedValueOnce(new Error('认证失败，请检查访问凭证'));

    // provider 失败在执行器里是 re-throw（sideChat.ipc 的 catch 负责归类 cause）
    await expect(new SubagentExecutor().execute(sideChatRequest()))
      .rejects.toThrow('认证失败，请检查访问凭证');
    expect(getSubagentContextStore().list(SIDE_CHAT_SESSION)).toHaveLength(0);

    mocks.responses.push(textResponse('重试的答案'));
    const retried = await new SubagentExecutor().execute(sideChatRequest());

    expect(retried).toMatchObject({ success: true, output: '重试的答案' });
    expect(getSubagentContextStore().list(SIDE_CHAT_SESSION)).toHaveLength(0);
    expect(workingAgentCount(SIDE_CHAT_SESSION)).toBe(0);
  });
});

describe('detached single subagent completion', () => {
  it('wakes the idle parent exactly once after waitForCompletion:false settles', async () => {
    vi.stubEnv('CODE_AGENT_MODEL_ENGINE', 'legacy');
    mocks.startTask.mockClear();
    mocks.getSessionState.mockReturnValue({ status: 'running', startTime: 1 });
    const sessionId = 'detached-report-session';
    const task = 'Find the rollback plan';
    const report = 'The rollback plan is in release.txt.';
    mocks.startTask.mockImplementation(async () => {
      const observe = mocks.observeAgentEvents.mock.lastCall?.[0];
      if (!observe) throw new Error('Expected the wake observer');
      observe(sessionId, { type: 'message', data: { role: 'assistant', content: report } });
    });
    const approvalRequested = Promise.withResolvers<void>();
    const approval = Promise.withResolvers<boolean>();
    const { context } = sideChatRequest(sessionId);
    const childContext = {
      ...context,
      suppressContextPublishing: false,
      runId: 'detached-report-parent',
      permission: {
        request: () => {
          approvalRequested.resolve();
          return approval.promise;
        },
      },
      resolver: {
        getDefinition: (name: string) => ({
          name,
          description: 'Read a workspace file',
          inputSchema: { type: 'object' as const },
          outputSchema: { type: 'object' as const },
          requiresPermission: true,
          permissionLevel: 'read' as const,
        }),
      },
    };
    mocks.executeTool.mockImplementationOnce(async () => ({
      success: await childContext.permission.request(),
      output: report,
    }));
    mocks.responses.push({
      type: 'tool_use',
      content: '',
      toolCalls: [{ id: 'read-rollback', name: 'Read', arguments: { path: 'release.txt' } }],
      usage: { inputTokens: 4, outputTokens: 5 },
    }, textResponse(report));

    try {
      const receipt = await executeSingleSpawnAgent({
        task, customPrompt: 'Identify the file.', customTools: ['Read'], waitForCompletion: false,
      }, childContext, 1, sessionId);
      expect(receipt).toMatchObject({ success: true, metadata: { background: true } });
      expect(receipt.output).toContain('Status: running');

      await approvalRequested.promise;
      const child = getSpawnGuard().list().find((agent) => agent.task === task);
      expect(child?.status).toBe('running');
      expect(getBackgroundSubagentRegistry().drainCompletionNotifications({ sessionId })).toEqual([]);
      expect(getSpawnGuard().drainNotifications({ sessionId })).toEqual([]);
      expect(mocks.startTask).not.toHaveBeenCalled();

      mocks.getSessionState.mockReturnValue({ status: 'idle' });
      approval.resolve(true);
      await expect(child?.promise).resolves.toMatchObject({ success: true });
      await vi.waitFor(() => expect(mocks.startTask).toHaveBeenCalledTimes(1));
      expect(mocks.startTask).toHaveBeenCalledWith(
        sessionId,
        expect.stringContaining(report),
        undefined,
        expect.objectContaining({ completionReportOnly: true }),
        expect.objectContaining({ automation: expect.objectContaining({ automationType: 'role_wake' }) }),
        expect.any(String),
      );
      expect(getBackgroundSubagentRegistry().drainCompletionNotifications({ sessionId })).toEqual([]);
      expect(getSpawnGuard().drainNotifications({ sessionId })).toEqual([]);
    } finally {
      approval.resolve(false);
      mocks.getSessionState.mockReset();
      mocks.startTask.mockReset();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { sessionId: 'team-detached-session', swarmRunScope: { sessionId: 'team-detached-session', runId: 'team-run', treeId: 'team-tree' } },
    { sessionId: 'goal-detached-session', suppressBackgroundSubagentIdleWake: true },
  ])('keeps the scoped SpawnGuard completion for $sessionId', async (scope) => {
    vi.stubEnv('CODE_AGENT_MODEL_ENGINE', 'legacy');
    mocks.startTask.mockClear();
    const { context } = sideChatRequest(scope.sessionId);
    const treeId = scope.swarmRunScope?.treeId ?? scope.sessionId;
    const task = 'Find the owner of the release plan';
    const report = 'The release manager owns the plan.';
    mocks.responses.push(textResponse(report));

    try {
      const receipt = await executeSingleSpawnAgent({
        task, customPrompt: 'Identify the owner.', customTools: [], waitForCompletion: false,
      }, { ...context, ...scope }, 1, treeId);
      expect(receipt.success).toBe(true);
      const child = getSpawnGuard().list().find((agent) => agent.id === receipt.metadata?.agentId);
      await expect(child?.promise).resolves.toMatchObject({ success: true, output: report });

      const registry = getBackgroundSubagentRegistry();
      expect(registry.getStatus(String(receipt.metadata?.agentId))).toBeUndefined();
      expect(registry.drainCompletionNotifications({ sessionId: scope.sessionId })).toEqual([]);
      expect(getSpawnGuard().drainNotifications(scope.swarmRunScope ?? { sessionId: scope.sessionId })).toEqual([
        expect.stringContaining(report),
      ]);
      expect(mocks.startTask).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps adopted goal work collectable and sends its completion through SpawnGuard', async () => {
    vi.stubEnv('CODE_AGENT_MODEL_ENGINE', 'legacy');
    mocks.startTask.mockClear();
    const sessionId = 'adopted-goal-session';
    const { context } = sideChatRequest(sessionId);
    const output = 'The release plan is ready for review.';
    const inference = Promise.withResolvers<ReturnType<typeof textResponse>>();
    mocks.inference.mockImplementationOnce(() => inference.promise);

    try {
      const receipt = await executeSingleSpawnAgent({
        task: 'Review the release plan',
        customPrompt: 'Summarize your review.',
        customTools: [],
        foregroundBlockingBudgetMs: 1,
      }, { ...context, suppressBackgroundSubagentIdleWake: true }, 1, sessionId);
      expect(receipt).toMatchObject({ success: true, metadata: { transferredToBackground: true } });
      const registry = getBackgroundSubagentRegistry();
      inference.resolve(textResponse(output));
      await expect(registry.await(String(receipt.metadata?.agentId))).resolves.toMatchObject({ success: true, output });

      expect(getSpawnGuard().drainNotifications({ sessionId })).toEqual([expect.stringContaining(output)]);
      expect(registry.drainCompletionNotifications({ sessionId })).toEqual([]);
      expect(mocks.startTask).not.toHaveBeenCalled();
    } finally {
      inference.resolve(textResponse(output));
      vi.unstubAllEnvs();
    }
  });

});
