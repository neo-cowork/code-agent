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
      metadata: {
        mcpStructuredContent: {
          apps: [
            { pid: 123, name: 'Keynote', bundle_id: 'com.apple.iWork.Keynote' },
            { pid: 456, name: 'Calculator', bundle_id: 'com.apple.calculator' },
          ],
          windows: [{ window_id: 77, app_name: 'Calculator' }],
        },
      },
    }),
  }),
}));

import { EventEmitter } from 'node:events';
import { SubagentExecutor } from '../../../src/host/agent/subagentExecutor';
import { buildAgentTreeSnapshot } from '../../../src/host/agent/agentTreeService';
import { getSubagentContextStore } from '../../../src/host/context/subagentContextStore';
import { logCollector } from '../../../src/host/mcp/logCollector.js';
import type { AgentEvent } from '../../../src/shared/contract';
import type { TaskManager, TaskManagerEvent } from '../../../src/host/task/TaskManager';
import { TaskProgressSchema } from '../../../src/shared/ipc/schemas/backgroundTask';
import { SessionCommandCenter } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import {
  getBackgroundTaskLedger,
  resetBackgroundTaskLedgerForTest,
} from '../../../src/host/task/backgroundTaskLedger';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';


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

  function tool(id: string, name: string, args: Record<string, unknown>): ToolCall {
    return { id, name, arguments: args };
  }

  async function runMember(agentId: string, toolCalls: ToolCall[]) {
    const starts: ToolCall[] = [];
    const ends: ToolResult[] = [];
    mocks.responses.push(
      { type: 'tool_use', content: '', toolCalls, usage },
      { type: 'text', content: 'The display reads 0 and the 7 key is on the keypad.', usage },
    );
    const result = await new SubagentExecutor().execute({
      prompt: 'Open Calculator, read the display, then check the same window for a 7 key',
      config: {
        name: 'calc-helper',
        systemPrompt: 'Operate the Calculator app and report the display',
        availableTools: [...new Set(toolCalls.map((call) => call.name))],
        maxIterations: 4,
      },
      context: {
        sessionId: SESSION,
        executionAgentId: agentId,
        cwd: '/tmp/work',
        modelConfig: { provider: 'test', model: 'test-model' },
        resolver: { getDefinition: (name: string) => ({ name, description: name, inputSchema: { type: 'object' as const }, outputSchema: { type: 'object' as const }, requiresPermission: false, permissionLevel: 'read' as const }) },
        permission: { request: async () => true },
        events: {
          emit(event: string, data: unknown) {
            if (event === 'tool_call_start') starts.push(data as ToolCall);
            if (event === 'tool_call_end') ends.push(data as ToolResult);
          },
        },
        abortSignal: new AbortController().signal,
      },
    } as never);
    const record = getSubagentContextStore().list(SESSION).find((item) => item.agentId === agentId);
    return { result, starts, ends, record, persisted: callsIn(record?.messages) };
  }

  it('attaches a disclosure only for shapes that name an app', async () => {
    const toolSpy = vi.spyOn(logCollector, 'tool');
    const shapes: Array<{ id: string; name: string; args: Record<string, unknown>; app: string | null }> = [
      { id: 'open-en', name: 'computer_use', args: { action: 'open_application', targetApp: 'Calculator' }, app: 'Calculator' },
      { id: 'open-zh', name: 'computer_use', args: { action: 'open_application', targetApp: '计算器' }, app: '计算器' },
      { id: 'observe', name: 'computer_use', args: { action: 'observe' }, app: null },
      { id: 'launch-name', name: 'mcp__cua-driver__launch_app', args: { name: 'Calculator' }, app: 'Calculator' },
      { id: 'launch-bundle', name: 'mcp__cua-driver__launch_app', args: { bundle_id: 'com.apple.calculator' }, app: 'com.apple.calculator' },
      { id: 'state-pid', name: 'mcp__cua-driver__get_window_state', args: { pid: 456 }, app: 'Calculator' },
      { id: 'state-window', name: 'mcp__cua-driver__get_window_state', args: { window_id: 77 }, app: 'Calculator' },
      { id: 'shot', name: 'mcp__cua-driver__screenshot', args: { window_id: 77 }, app: null },
      { id: 'desktop', name: 'mcp__cua-driver__get_desktop_state', args: {}, app: null },
      { id: 'apps', name: 'mcp__cua-driver__list_apps', args: {}, app: null },
    ];
    const matrix: Array<{ id: string; attached: { code: string; app: string } | null }> = [];
    try {
      for (const shape of shapes) {
        const run = await runMember(`shape-${shape.id}`, [tool(shape.id, shape.name, shape.args)]);
        const attached = run.starts[0]?.guiTakeoverDisclosure ?? null;
        matrix.push({ id: shape.id, attached });
        expect(run.result).toMatchObject({ success: true });
        expect(attached).toEqual(shape.app ? { code: 'gui_takeover', app: shape.app } : null);
        expect(run.persisted.find((call) => call.id === shape.id)?.guiTakeoverDisclosure ?? null).toEqual(attached);
      }
      console.info(`GUI_DISCLOSURE_SHAPE ${JSON.stringify(matrix)}`);
      expect(toolSpy.mock.calls.filter((entry) => entry[0] === 'WARN')).toEqual([]);
    } finally {
      toolSpy.mockRestore();
    }
  });

  it('dedups the same app across case and trim, discloses a different app, and projects task.progress.guiDisclosures', async () => {
    const calls = [
      tool('first', 'computer_use', { action: 'open_application', targetApp: 'Calculator' }),
      tool('again', 'computer_use', { action: 'click', targetApp: ' calculator ' }),
      tool('notes', 'mcp__cua-driver__launch_app', { name: 'Notes' }),
      tool('reread', 'mcp__cua-driver__get_window_state', { pid: 456 }),
      tool('shot', 'mcp__cua-driver__screenshot', { window_id: 77 }),
      tool('observe', 'computer_use', { action: 'observe' }),
    ];
    const run = await runMember('calc-member', calls);
    expect(run.result).toMatchObject({ success: true });
    expect(run.starts.find((call) => call.id === 'first')?.guiTakeoverDisclosure).toEqual({ code: 'gui_takeover', app: 'Calculator' });
    expect(run.starts.find((call) => call.id === 'again')?.guiTakeoverDisclosure).toBeUndefined();
    expect(run.starts.find((call) => call.id === 'notes')?.guiTakeoverDisclosure).toEqual({ code: 'gui_takeover', app: 'Notes' });
    for (const id of ['reread', 'shot', 'observe']) {
      expect(run.starts.find((call) => call.id === id)?.guiTakeoverDisclosure).toBeUndefined();
      expect(run.persisted.find((call) => call.id === id)?.guiTakeoverDisclosure).toBeUndefined();
    }
    expect(run.persisted.find((call) => call.id === 'again')?.guiTakeoverDisclosure).toBeUndefined();
    const expected = [{ app: 'Calculator', callId: 'first' }, { app: 'Notes', callId: 'notes' }];
    expect(run.record?.snapshot?.guiDisclosures).toEqual(expected);
    console.info(`GUI_DISCLOSURE_DEDUP ${JSON.stringify({
      first: run.starts.find((call) => call.id === 'first')?.guiTakeoverDisclosure ?? null,
      again: run.starts.find((call) => call.id === 'again')?.guiTakeoverDisclosure ?? null,
      notes: run.starts.find((call) => call.id === 'notes')?.guiTakeoverDisclosure ?? null,
      guiDisclosures: run.record?.snapshot?.guiDisclosures ?? null,
    })}`);

    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
    const manager = new DisclosureTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
      wakeForegroundBrain: vi.fn(),
    });
    try {
      const spawned = await center.spawn({
        sessionId: 'session-gui',
        title: '核对计算器显示',
        shortName: '计算器',
        laneKey: 'lane-calc',
        submissionKey: 'submission-calc',
        prompt: '打开计算器，读当前显示，再看同一个窗口有没有数字 7',
        workspaceScope: createWorkspaceScope('project-gui', [{
          sourceId: 'source-gui',
          path: '/tmp/gui-project',
          role: 'primary',
          access: 'read_write',
        }]),
      });
      if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');
      for (const id of ['first', 'notes']) {
        const data = run.starts.find((call) => call.id === id);
        manager.emitAgent('session-gui', { type: 'tool_call_start', data } as AgentEvent, spawned.task.id);
      }
      const progress = TaskProgressSchema.parse(
        getBackgroundTaskLedger().listTasks({ sessionId: 'session-gui' }).find((task) => task.id === spawned.task.id)?.progress,
      );
      expect(progress.guiDisclosures).toEqual(expected);
      console.info(`GUI_DISCLOSURE_PROGRESS ${JSON.stringify(progress.guiDisclosures)}`);
    } finally {
      center.dispose();
    }
  });

  it('unresolved cua call warns with the resolver reason and the tool call still ends', async () => {
    const toolSpy = vi.spyOn(logCollector, 'tool');
    try {
      const run = await runMember('unresolved-member', [
        tool('miss', 'mcp__cua-driver__click', { pid: 999, x: 1, y: 1 }),
      ]);
      expect(run.result).toMatchObject({ success: true });
      expect(run.starts[0]?.guiTakeoverDisclosure).toBeUndefined();
      expect(run.ends).toEqual([expect.objectContaining({ toolCallId: 'miss', success: true })]);
      const warns = toolSpy.mock.calls.filter((entry) => entry[0] === 'WARN');
      expect(warns).toEqual([[
        'WARN',
        'GUI takeover disclosure unresolved (tool runs without disclosure)',
        expect.objectContaining({
          toolCallId: 'miss',
          toolName: 'mcp__cua-driver__click',
          reason: expect.stringContaining('pid 999'),
        }),
      ]]);
      console.info(`GUI_DISCLOSURE_UNRESOLVED ${JSON.stringify({ level: warns[0]?.[0], message: warns[0]?.[1], meta: warns[0]?.[2] })}`);
    } finally {
      toolSpy.mockRestore();
    }
  });
});

class DisclosureTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockResolvedValue(undefined);
  interruptBackgroundTask = vi.fn().mockResolvedValue(true);
  cancelBackgroundTask = vi.fn().mockResolvedValue(true);
  private readonly agentObservers = new Set<(sessionId: string, event: AgentEvent, taskId?: string) => void>();

  observeAgentEvents(observer: (sessionId: string, event: AgentEvent, taskId?: string) => void): () => void {
    this.agentObservers.add(observer);
    return () => { this.agentObservers.delete(observer); };
  }

  emitAgent(sessionId: string, event: AgentEvent, taskId?: string): void {
    for (const observer of this.agentObservers) observer(sessionId, event, taskId);
  }

  emitTask(event: TaskManagerEvent): void {
    this.emit(event.type, event);
  }
}
