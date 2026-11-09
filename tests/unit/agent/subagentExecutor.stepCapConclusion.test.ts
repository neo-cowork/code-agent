import { beforeEach, describe, expect, it, vi } from 'vitest';

const DURABLE_AGENT_ID = 'subagent-bg-cap';

const mocks = vi.hoisted(() => {
  const pageInfo = { value: null as string | null };
  const responses: Array<Record<string, unknown>> = [];
  const state = { progressError: false, spent: 0 };
  const inference = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Missing mocked inference response');
    return response;
  });
  const noteLiveProgress = vi.fn((_agentId: string, _snapshot: { cost?: number; lastProgress?: string }) => {
    if (state.progressError) throw new Error('ledger write failed');
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
    getBudgetStatus: vi.fn(() => ({ subagentCost: state.spent })),
    getRemainingBudget: vi.fn(() => undefined),
    recordTokenUsage: vi.fn(() => { state.spent += 1.25; }),
    recordToolUsage: vi.fn(),
  };
  return { pageInfo, responses, state, inference, noteLiveProgress, pipeline, pipelineContext };
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
    executor: { execute: vi.fn(async () => ({ success: true, output: mocks.pageInfo.value ?? 'Navigated to: https://zh.wikipedia.org/wiki/Foo\nTitle: 福 - 维基百科' })) },
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

vi.mock('../../../src/host/context/subagentContextStore', () => ({
  getSubagentContextStore: () => ({ upsert: vi.fn() }),
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

vi.mock('../../../src/host/agent/spawnGuard', () => ({
  getSpawnGuard: () => ({
    drainMessages: () => [],
    peekMessages: () => [],
    cancelDescendants: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/backgroundSubagentRegistry', () => ({
  getBackgroundSubagentRegistry: () => ({
    noteLiveProgress: mocks.noteLiveProgress,
    getStatus: () => undefined,
  }),
}));

import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';

function browserResponse(i: number) {
  return {
    type: 'tool_use',
    content: '',
    toolCalls: [{ id: `nav-${i}`, name: 'Read', arguments: { path: `p${i}` } }],
    usage: { inputTokens: 3, outputTokens: 2 },
  };
}

function createRequest(maxIterations: number) {
  return {
    prompt: 'Open the wiki pages',
    config: {
      name: 'Cap Agent',
      systemPrompt: 'Browse.',
      availableTools: ['Read'],
      maxIterations,
    },
    context: {
      sessionId: 'cap-session',
      runId: 'cap-run',
      executionAgentId: 'executor-agent',
      cwd: '/tmp',
      modelConfig: { provider: 'test', model: 'test-model' },
      resolver: {
        getDefinition: (name: string) => ({
          name,
          description: `${name} test tool`,
          inputSchema: { type: 'object' as const },
          outputSchema: { type: 'object' as const },
          requiresPermission: false,
          permissionLevel: 'read' as const,
        }),
      },
      permission: { request: vi.fn(async () => true) },
      events: { emit: vi.fn(), backgroundDurableAgentId: DURABLE_AGENT_ID },
      abortSignal: new AbortController().signal,
    },
  };
}

describe('SubagentExecutor step cap conclusion', () => {
  beforeEach(() => {
    mocks.responses.length = 0;
    vi.clearAllMocks();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });

  it('turns a cap hit with no text into an incomplete result carrying a Chinese conclusion', async () => {
    mocks.responses.push(browserResponse(1), browserResponse(2), browserResponse(3));

    const result = await new SubagentExecutor().execute(createRequest(3));

    expect(result.success).toBe(false);
    expect(result.iterations).toBe(3);
    expect(result.output).toContain('第 3 步（上限 3 步）');
    expect(result.output).toContain('最后停留在页面「福 - 维基百科」');
    expect(result.output).toContain('继续');
    expect(result.error).toBe(result.output);
    expect(result.output).not.toContain('Subagent completed without output');
  });

  it('falls back to the last requested url when tool results carry no page info', async () => {
    const fetchCall = (i: number) => ({
      type: 'tool_use', content: '',
      toolCalls: [{ id: `f-${i}`, name: 'Read', arguments: { url: `http://www.sina.com.cn/p${i}` } }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    mocks.responses.push(fetchCall(1), fetchCall(2));
    mocks.pageInfo.value = 'plain text without page markers';

    const result = await new SubagentExecutor().execute(createRequest(2));

    mocks.pageInfo.value = null;
    expect(result.success).toBe(false);
    expect(result.output).toContain('最后停留在页面http://www.sina.com.cn/p2');
  });

  it('still completes normally when the last round produced text', async () => {
    mocks.responses.push(browserResponse(1), { type: 'text', content: 'done', usage: { inputTokens: 1, outputTokens: 1 } });

    const result = await new SubagentExecutor().execute(createRequest(2));

    expect(result).toMatchObject({ success: true, output: 'done' });
  });
});
