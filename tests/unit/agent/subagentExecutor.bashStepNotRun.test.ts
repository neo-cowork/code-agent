import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message, ToolCall, ToolResult } from '../../../src/shared/contract';
import type { SubagentExecutionContext } from '../../../src/host/agent/subagentExecutorTypes';

const contextStoreHolder = vi.hoisted(() => ({ instance: undefined as unknown }));

vi.mock('../../../src/host/context/subagentContextStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/context/subagentContextStore')>();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'bashstep-notrun-'));
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
  const toolOutcomes = new Map<string, 'ran' | 'denied'>();
  const requestApproval = vi.fn(async (_id: string) => true);
  return { responses, inference, pipeline, pipelineContext, toolOutcomes, requestApproval };
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
    executor: {
      execute: vi.fn(async (_name: string, _args: unknown, options: { currentToolCallId?: string }) => (
        !(await mocks.requestApproval(options.currentToolCallId ?? '')) || mocks.toolOutcomes.get(options.currentToolCallId ?? '') === 'denied'
          ? { success: false, error: 'Permission denied by user.', metadata: { failureCode: 'PERMISSION_DENIED', hostReason: { code: 'PERMISSION_DENIED_BY_USER', modelText: 'Permission denied by user.' } } }
          : { success: true, output: 'ok' }
      )),
    },
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

vi.mock('../../../src/host/mcp/mcpClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/mcp/mcpClient')>(),
  getMCPClient: () => ({
    callTool: async () => ({
      success: true,
      output: '',
      metadata: { mcpStructuredContent: { apps: [{ pid: 123, name: 'Keynote', bundle_id: 'com.apple.iWork.Keynote' }] } },
    }),
  }),
}));

import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';
import { buildAgentTreeSnapshot } from '../../../src/host/agent/agentTreeService';
import { getSubagentContextStore } from '../../../src/host/context/subagentContextStore';


function bashCall(id: string, command: string, description: string) {
  return { id, name: 'Bash', arguments: { command, description } };
}

const SESSION = 'bashstep-session';

describe('subagent Bash steps carry callId and notRun (executor snapshot == agentTree rebuild)', () => {
  beforeEach(() => {
    mocks.responses.length = 0;
    mocks.toolOutcomes.clear();
    vi.clearAllMocks();
    mocks.requestApproval.mockReset().mockResolvedValue(true);
    process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  });
  afterEach(() => {
    delete process.env.CODE_AGENT_MODEL_ENGINE;
  });

  it('(f) denied-then-retried identical command: both producers mark only the denied call id', async () => {
    mocks.toolOutcomes.set('b1', 'denied');
    mocks.responses.push(
      { type: 'tool_use', content: '', toolCalls: [bashCall('b0', 'ls', '看看目录')], usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'tool_use', content: '', toolCalls: [bashCall('b1', 'ls ~/Downloads', '看看下载文件夹')], usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'tool_use', content: '', toolCalls: [bashCall('b2', 'ls ~/Downloads', '看看下载文件夹')], usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'text', content: '完成', usage: { inputTokens: 1, outputTokens: 1 } },
    );
    const snapshots: Array<{ bashSteps?: Array<{ callId?: string; notRun?: boolean }> }> = [];
    const result = await new SubagentExecutor().execute({
      prompt: '整理下载文件夹',
      config: { name: 'tidy', systemPrompt: '整理文件', availableTools: ['Bash'], maxIterations: 6 },
      context: {
        sessionId: SESSION,
        cwd: '/tmp/work',
        modelConfig: { provider: 'test', model: 'test-model' },
        resolver: { getDefinition: (name: string) => ({ name, description: name, inputSchema: { type: 'object' as const }, outputSchema: { type: 'object' as const }, requiresPermission: false, permissionLevel: 'read' as const }) },
        permission: { request: async () => true },
        events: { emit() { /* not under test */ } },
        abortSignal: new AbortController().signal,
        onContextSnapshot: (snapshot: { bashSteps?: Array<{ callId?: string; notRun?: boolean }> }) => snapshots.push(snapshot),
      },
    } as never);
    expect(result).toMatchObject({ success: true });

    const marks = (steps?: Array<{ callId?: string; notRun?: boolean }>) => (steps ?? []).map((s) => [s.callId, s.notRun ?? false]);
    const expected = [['b0', false], ['b1', true], ['b2', false]];
    expect(marks(snapshots[snapshots.length - 1]?.bashSteps)).toEqual(expected);

    const tree = buildAgentTreeSnapshot({
      now: Date.now(), sessionId: SESSION, contextRecords: getSubagentContextStore().list(SESSION),
      spawnAgents: [], parallelTasks: [], backgroundAgents: [], worktrees: [], ownershipConflicts: [],
    });
    expect(tree.nodes).toHaveLength(1);
    expect(marks(tree.nodes[0]?.bashSteps)).toEqual(expected);
    expect(tree.nodes[0]?.lastToolStep).toMatchObject({ tool: 'Bash', callId: 'b2' });
    expect(tree.nodes[0]?.lastToolStep?.notRun).toBeUndefined();
  });
});


const bashKeynote = bashCall(
  'bash-keynote',
  `osascript -e 'tell application "System Events" to tell process "Keynote" to keystroke "1"'`,
  'Edit the slide title',
);
const cuaKeynote = { id: 'cua-keynote', name: 'mcp__cua-driver__click', arguments: { pid: 123, x: 100, y: 200 } };
const numbers = bashCall('numbers', `osascript -e 'tell application "Numbers" to activate'`, 'Open the spreadsheet');
const connector: ToolCall = {
  id: 'connector',
  name: 'tmeetMeetingListUpcoming',
  arguments: {},
  shortDescription: 'List upcoming meetings',
  guiTakeoverDisclosure: { code: 'gui_takeover', app: 'Keynote' },
};
const metadata = { id: 'metadata', name: 'mcp__cua-driver__list_apps', arguments: {} };
const keynote = { code: 'gui_takeover', app: 'Keynote' };
const usage = { inputTokens: 1, outputTokens: 1 };

function callsIn(messages: Message[] | undefined): ToolCall[] {
  return messages?.flatMap((message) => message.toolCalls ?? []) ?? [];
}

describe('member GUI disclosures through SubagentExecutor.execute', () => {
  beforeEach(() => {
    mocks.responses.length = 0;
    mocks.toolOutcomes.clear();
    mocks.requestApproval.mockReset().mockResolvedValue(true);
    vi.stubEnv('CODE_AGENT_MODEL_ENGINE', 'legacy');
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { first: cuaKeynote, second: bashKeynote },
    { first: bashKeynote, second: cuaKeynote },
  ])('publishes $first.id before approval and retains it across later actions', async ({ first, second }) => {
    const timeline: string[] = [];
    const starts: ToolCall[] = [];
    const ends: ToolResult[] = [];
    const agentId = `member-${first.id}`;
    const readRecord = () => getSubagentContextStore().list(SESSION).find((record) => record.agentId === agentId);
    const permission: SubagentExecutionContext['permission'] = {
      request: vi.fn(async (request) => {
        const id = String(request.details.callId);
        timeline.push(`approval:${id}`);
        if (id === first.id) {
          expect(callsIn(readRecord()?.messages).find((call) => call.id === id)?.guiTakeoverDisclosure).toEqual(keynote);
        }
        return id !== second.id;
      }),
    };
    mocks.requestApproval.mockImplementation((callId) => permission.request({
      type: 'command', tool: 'Bash', details: { callId },
    }) as Promise<boolean>);

    const executor = new SubagentExecutor();
    const tools = [first, second, numbers, connector, metadata];
    const run = (batches: ToolCall[][]) => {
      mocks.responses.push(
        ...batches.map((toolCalls) => ({ type: 'tool_use', content: '', toolCalls, usage })),
        { type: 'text', content: 'Finished', usage },
      );
      return executor.execute({
        prompt: 'Edit the Keynote deck',
        config: { name: 'slides', systemPrompt: 'Edit slides', availableTools: tools.map((call) => call.name), maxIterations: 5 },
        context: {
          sessionId: SESSION,
          executionAgentId: agentId,
          cwd: '/tmp/work',
          modelConfig: { provider: 'test', model: 'test-model' },
          resolver: { getDefinition: (name: string) => ({ name, description: name, inputSchema: { type: 'object' as const }, outputSchema: { type: 'object' as const }, requiresPermission: false, permissionLevel: 'read' as const }) },
          permission,
          events: {
            emit(event: string, data: unknown) {
              if (event === 'tool_call_start') {
                starts.push(data as ToolCall);
                timeline.push(`start:${(data as ToolCall).id}`);
              }
              if (event === 'tool_call_end') ends.push(data as ToolResult);
            },
          },
          abortSignal: new AbortController().signal,
        },
      } as never);
    };

    const expected = [{ app: 'Keynote', callId: first.id }, { app: 'Numbers', callId: numbers.id }];
    expect(await run([[first, second], [numbers, connector, metadata]])).toMatchObject({ success: true });
    const record = readRecord();
    const persisted = callsIn(record?.messages);
    console.info(JSON.stringify({
      start: starts[0], persistedToolCall: persisted[0], guiDisclosures: record?.snapshot?.guiDisclosures,
    }));
    expect(starts[0]?.guiTakeoverDisclosure).toEqual(keynote);
    expect(persisted[0]?.guiTakeoverDisclosure).toEqual(keynote);
    expect(record?.snapshot?.guiDisclosures).toEqual(expected);
    for (const calls of [starts, persisted]) {
      expect(calls.find((call) => call.id === connector.id)?.shortDescription).toBe(connector.shortDescription);
      expect(calls.find((call) => call.id === second.id)?.guiTakeoverDisclosure).toBeUndefined();
      expect(calls.find((call) => call.id === numbers.id)?.guiTakeoverDisclosure).toEqual({ code: 'gui_takeover', app: 'Numbers' });
      for (const id of [connector.id, metadata.id]) {
        expect(calls.find((call) => call.id === id)).toMatchObject({ id });
        expect(calls.find((call) => call.id === id)?.guiTakeoverDisclosure).toBeUndefined();
      }
    }
    for (const id of [first.id, second.id]) {
      expect(timeline.indexOf(`start:${id}`)).toBeGreaterThanOrEqual(0);
      expect(timeline.indexOf(`start:${id}`)).toBeLessThan(timeline.indexOf(`approval:${id}`));
    }
    expect(ends).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCallId: first.id, success: true }),
      expect.objectContaining({ toolCallId: second.id, success: false }),
    ]));
    const tree = buildAgentTreeSnapshot({
      now: Date.now(), sessionId: SESSION, contextRecords: record ? [record] : [],
      spawnAgents: [], parallelTasks: [], backgroundAgents: [], worktrees: [], ownershipConflicts: [],
    });
    expect(tree.nodes[0]?.guiDisclosures).toEqual(expected);

    starts.length = 0;
    expect(await run([[first]])).toMatchObject({ success: true });
    expect(starts[0]?.guiTakeoverDisclosure).toEqual(keynote);
    expect(readRecord()?.snapshot?.guiDisclosures).toEqual([expected[0]]);
  });
});
