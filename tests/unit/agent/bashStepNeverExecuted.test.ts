// ============================================================================
// 「从未执行」的 Bash 步骤写回 BashStep.notRun（N-FIX-...-FU2-FU1）
// 真实 SubagentExecutor + 真实 subagentContextStore + 真实 buildAgentTreeSnapshot，
// 工具执行器桩返回宿主真实的拒绝形状（审批被拒 / 运行策略封口 / 跑过后失败）。
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
  const toolResults: Array<Record<string, unknown>> = [];
  return { responses, inference, pipeline, pipelineContext, toolResults };
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
    executor: { execute: vi.fn(async () => mocks.toolResults.shift() ?? { success: true, output: 'ok' }) },
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
    noteLiveProgress: vi.fn(),
    getStatus: () => undefined,
  }),
}));

import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';
import { buildAgentTreeSnapshot } from '../../../src/host/agent/agentTreeService';
import { getSubagentContextStore } from '../../../src/host/context/subagentContextStore';
import { AgentFailureCode, HostReasonCode } from '../../../src/shared/contract';

const SESSION = 'never-executed-bash-session';

function bashCall(id: string, description: string, command: string) {
  return { id, name: 'Bash', arguments: { description, command } };
}

function request() {
  return {
    prompt: '后台跑三步',
    config: { name: 'bash-helper', systemPrompt: '依次执行。', availableTools: ['Bash'], maxIterations: 4 },
    context: {
      sessionId: SESSION,
      cwd: '/tmp/work',
      modelConfig: { provider: 'test', model: 'test-model' },
      resolver: {
        getDefinition: (name: string) => ({
          name, description: `${name} test tool`, inputSchema: { type: 'object' as const },
          outputSchema: { type: 'object' as const }, requiresPermission: false, permissionLevel: 'read' as const,
        }),
      },
      permission: { request: async () => false },
      events: { emit() { /* no-op */ } },
      abortSignal: new AbortController().signal,
    },
  };
}

async function runThreeSteps(second: Record<string, unknown>) {
  mocks.responses.push(
    {
      type: 'tool_use',
      content: '',
      toolCalls: [
        bashCall('c1', 'Check today date', 'date'),
        bashCall('c2', 'List Downloads folder', 'ls ~/Downloads'),
        bashCall('c3', 'Count the PDFs', 'ls ~/Downloads | grep -c pdf'),
      ],
      usage: { inputTokens: 3, outputTokens: 2 },
    },
    { type: 'text', content: 'done', usage: { inputTokens: 4, outputTokens: 5 } },
  );
  mocks.toolResults.push({ success: true, output: 'Fri' }, second, { success: true, output: '3' });
  await new SubagentExecutor().execute(request());
  const snapshot = buildAgentTreeSnapshot({
    now: Date.now(), sessionId: SESSION, contextRecords: getSubagentContextStore().list(SESSION),
    spawnAgents: [], parallelTasks: [], backgroundAgents: [], worktrees: [], ownershipConflicts: [],
  });
  const record = getSubagentContextStore().list(SESSION)[0];
  return { treeSteps: snapshot.nodes.flatMap((node) => node.bashSteps ?? []), snapshotSteps: record.snapshot?.bashSteps ?? [] };
}

describe('SubagentExecutor persists never-executed Bash outcome on BashStep', () => {
  beforeEach(() => {
    mocks.responses.length = 0;
    mocks.toolResults.length = 0;
    vi.clearAllMocks();
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
    getSubagentContextStore().clearSession(SESSION);
  });
  afterEach(() => { delete process.env.CODE_AGENT_MODEL_ENGINE; });

  it.each([
    ['approval denied', { success: false, error: 'denied', metadata: { failureCode: AgentFailureCode.PermissionDenied, hostReason: { code: HostReasonCode.PermissionDeniedByUser } } }],
    ['run policy bounce', { success: false, error: 'disabled', metadata: { code: 'TOOL_DISABLED_FOR_RUN', bounced: true } }],
    ['sealed skipped', { success: false, error: 'sealed', metadata: { skipped: true, bounced: true } }],
  ])('marks exactly the %s step notRun in the snapshot and the agent tree', async (_name, denial) => {
    const { treeSteps, snapshotSteps } = await runThreeSteps(denial);
    expect(snapshotSteps).toHaveLength(3);
    expect(snapshotSteps.filter((step) => step.notRun)).toEqual([expect.objectContaining({ description: 'List Downloads folder', notRun: true })]);
    expect(treeSteps).toHaveLength(3);
    expect(treeSteps.filter((step) => step.notRun).map((step) => step.description)).toEqual(['List Downloads folder']);
  });

  it('does not mark a Bash that ran and exited non-zero', async () => {
    const { treeSteps, snapshotSteps } = await runThreeSteps({ success: false, error: 'exit 1', metadata: { exitCode: 1, executed: true } });
    expect(snapshotSteps.some((step) => step.notRun)).toBe(false);
    expect(treeSteps.some((step) => step.notRun)).toBe(false);
  });
});
