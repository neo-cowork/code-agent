import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CompressionPipeline } from '../../../src/host/context/compressionPipeline';

const mocks = vi.hoisted(() => {
  const responses: Array<Record<string, unknown>> = [];
  const inferenceMessages: Array<Array<{ role: string; content: unknown; toolCalls?: Array<{ id: string }> }>> = [];
  const inference = vi.fn(async (messages: Array<{ role: string; content: unknown }>) => {
    inferenceMessages.push(structuredClone(messages));
    const response = responses.shift();
    if (!response) throw new Error('Missing mocked inference response');
    return response;
  });
  const toolExecute = vi.fn(async (name: string, _args: Record<string, unknown>) => ({
    success: true,
    output: `${name} partial output`,
  }));
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
  return { responses, inferenceMessages, inference, toolExecute, pipeline, pipelineContext, useAiSdk: false, publishedMessages: [] as Array<{ id: string; role: string; content: string }> };
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
  aiSdkSupportsProvider: () => mocks.useAiSdk,
  inferenceViaAiSdk: mocks.inference,
}));

vi.mock('../../../src/host/agent/subagentPipeline', () => ({
  getSubagentPipeline: () => mocks.pipeline,
}));

vi.mock('../../../src/host/agent/subagentToolRuntime', () => ({
  createSubagentToolRuntime: () => ({
    executor: { execute: mocks.toolExecute },
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
  getSubagentContextStore: () => ({ upsert: (record: { messages: typeof mocks.publishedMessages }) => {
    mocks.publishedMessages = structuredClone(record.messages);
  } }),
}));

vi.mock('../../../src/host/context/contextInterventionState', () => ({
  getContextInterventionState: () => ({ getEffectiveSnapshot: () => ({}) }),
}));

vi.mock('../../../src/host/context/contextInterventionHelpers', () => ({
  applyInterventionsToMessages: (messages: unknown) => messages,
}));


vi.mock('../../../src/host/telemetry/telemetryCollector', () => ({
  getTelemetryCollector: () => ({ recordDetachedTurn: vi.fn() }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(),
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
  // K2：子代理分流前统一收窄 request；本用例不测边界，透传即可（不许在这里模拟收窄，
  // 否则 doomLoop 的断言会被无关的工具表变化带偏）。
  applyRoleBoundaryToSubagentRequest: vi.fn((request: unknown) => request),
}));

vi.mock('../../../src/host/agent/spawnGuard', () => ({
  getSpawnGuard: () => ({
    drainMessages: () => [],
    peekMessages: () => [],
    cancelDescendants: vi.fn(),
  }),
}));

import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';

type CapturedEvent = { type: string; data: Record<string, unknown> };

function toolResponse(
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
) {
  return {
    type: 'tool_use',
    content: '',
    toolCalls: calls,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function textResponse(content: string) {
  return {
    type: 'text',
    content,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function createHarness() {
  const events: CapturedEvent[] = [];
  const resolver = {
    getDefinition: (name: string) => ({
      name,
      description: `${name} test tool`,
      inputSchema: { type: 'object' as const },
      outputSchema: { type: 'object' as const },
      requiresPermission: false,
      permissionLevel: 'read' as const,
    }),
  };
  const context = {
    sessionId: 'doom-session',
    runId: 'doom-run',
    executionAgentId: 'doom-agent',
    cwd: '/tmp',
    modelConfig: { provider: 'test', model: 'test-model' },
    resolver,
    permission: { request: vi.fn(async () => true) },
    events: {
      emit: (type: string, data: unknown) => events.push({
        type,
        data: data as Record<string, unknown>,
      }),
    },
    abortSignal: new AbortController().signal,
  };
  const config = {
    name: 'Doom Test Agent',
    systemPrompt: 'Test the background loop.',
    availableTools: ['Read', 'Grep'],
    maxIterations: 10,
  };
  return { events, request: { prompt: 'Run the test', config, context } };
}

// The same 250,000-byte bound is asserted by the foreground assembly test.
const REQUEST_BYTE_BOUND = 250_000;
const ROUNDS = 32;
const body = 'Documentation paragraph about configuration and lifecycle.\n'.repeat(700)
  + '\n\nTool Read: Success\nThis status line belongs to the document, not the envelope.';

async function runLongSession(aiSdk = false) {
  mocks.responses.length = 0;
  mocks.inferenceMessages.length = 0;
  mocks.toolExecute.mockImplementation(async (name, args) => ({
    success: true, output: `${name} page=${args.page}\n${body}`,
  }));
  for (let round = 1; round <= ROUNDS; round++) {
    mocks.responses.push(toolResponse([
      { id: `read-${round}`, name: 'Read', arguments: { path: `page-${round}.html`, page: round } },
      { id: `grep-${round}`, name: 'Grep', arguments: { pattern: `heading-${round}`, page: round } },
    ]));
  }
  mocks.responses.push(textResponse('Summary written.'));
  const { request } = createHarness();
  request.config.maxIterations = ROUNDS + 1;
  mocks.useAiSdk = aiSdk;
  process.env.CODE_AGENT_MODEL_ENGINE = aiSdk ? 'aisdk' : 'legacy';
  const result = await new SubagentExecutor().execute(request);
  expect(result.success).toBe(true);
  expect(mocks.inferenceMessages).toHaveLength(ROUNDS + 1);
  return mocks.inferenceMessages.map((messages) => Buffer.byteLength(JSON.stringify(messages)));
}

describe('SubagentExecutor shared context compression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CODE_AGENT_MODEL_ENGINE', 'legacy');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each([false, true])('bounds real executor requests while disconnected sessions exceed the bound (AI SDK=%s)', async (aiSdk) => {
    const sizes = await runLongSession(aiSdk);
    expect(Math.max(...sizes)).toBeLessThan(REQUEST_BYTE_BOUND);
    const last = mocks.inferenceMessages.at(-1)!;
    // Fresh results are whole; old individual results are independently archived.
    expect(JSON.stringify(last)).toContain(`Read page=${ROUNDS}\n${body}`.replace(/\n/g, '\\n'));
    const envelopes = last.filter((message) => message.role === 'user' && String(message.content).startsWith('Tool results:'));
    expect(envelopes).toHaveLength(ROUNDS);
    const stored = mocks.publishedMessages.filter((message) => message.role === 'user' && message.content.startsWith('Tool results:'));
    expect(stored).toHaveLength(ROUNDS);
    expect(stored.every((message) => message.content.includes(body) && !message.content.includes('[TOOL_RESULT_ARCHIVED]'))).toBe(true);
    // Per-run state reuses the same archive pointer on every later request.
    const archiveAtThirdRound = String(mocks.inferenceMessages[2][3].content).match(/archive: ([^\n]+)/)![1];
    const firstArchive = String(envelopes[0].content);
    expect(firstArchive.match(/\[TOOL_RESULT_ARCHIVED\]/g)).toHaveLength(2);
    const archivePath = firstArchive.match(/archive: ([^\n]+)/)![1];
    expect(archivePath).toBe(archiveAtThirdRound);
    expect(readFileSync(archivePath, 'utf8')).toContain(body);
    expect(last.filter((message) => message.toolCalls?.length).flatMap((message) => message.toolCalls!)).toHaveLength(ROUNDS * 2);

    // Disconnect only the shared compression boundary. Keep real executor,
    // tool loop and last-resort compactor identical for the baseline session.
    vi.spyOn(CompressionPipeline.prototype, 'evaluate').mockImplementation(async (transcript, state) => ({
      apiView: transcript, totalTokens: 0, layersTriggered: [], compressionState: state,
    }));
    const without = await runLongSession(aiSdk);
    expect(Math.max(...without)).toBeGreaterThan(REQUEST_BYTE_BOUND);
    process.stdout.write(`request-byte-bound=${REQUEST_BYTE_BOUND} wired-max=${Math.max(...sizes)} disconnected-max=${Math.max(...without)} rounds=${ROUNDS} aisdk=${aiSdk}\n`);
  });
});
