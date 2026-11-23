// ============================================================================
// GUI 接管披露 · 生产链路（N-CUA-HOST-GUI-DISCLOSURE）
//
// 经真 MessageProcessor.handleToolResponse + 真 ToolExecutionEngine：模型本轮
// 一言不发（content 空），首次直接驱动 Keynote 界面的调用仍会在落库消息、
// tool_call_start 事件上携带结构化披露，且顺序在 executor 派发之前；同 app
// 第二次不重复。删掉 messageProcessor 里的 attachGuiTakeoverDisclosures 注入点，
// 这些断言必须翻红（验收②反向变异锚点）。
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../../../src/host/agent/loopTypes';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { AgentEvent, Message, ToolResult } from '../../../src/shared/contract';
import { logCollector } from '../../../src/host/mcp/logCollector.js';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

const sessionManagerState = vi.hoisted(() => ({ addMessageToSession: vi.fn() }));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
  getLangfuseService: () => ({ startNestedSpan: vi.fn(), endSpan: vi.fn() }),
  getConfigService: vi.fn(),
  getAuthService: vi.fn(),
  getBudgetService: vi.fn(),
  BudgetAlertLevel: {},
}));

vi.mock('../../../src/host/services/git/fileWatcherService', () => ({
  getFileWatcherService: () => ({ getRecentExternalChanges: vi.fn().mockReturnValue([]) }),
}));

vi.mock('../../../src/host/services/git/gitStatusService', () => ({
  getGitStatusService: () => ({ onPostToolUse: vi.fn() }),
}));

vi.mock('../../../src/host/services/citation/citationService', () => ({
  getCitationService: () => ({ extractAndStore: vi.fn().mockReturnValue([]) }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getToolAnnotationsMap: () => new Map(),
    getToolDefinitions: () => [],
    callTool: vi.fn(async () => ({
      success: true,
      metadata: { mcpStructuredContent: { apps: [{ pid: 123, name: 'Keynote', bundle_id: 'com.apple.iWork.Keynote' }] } },
    })),
    parseMCPToolName: () => null,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { MessageProcessor } from '../../../src/host/agent/runtime/messageProcessor';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';

const KEYNOTE_CLICK = {
  id: 'cu-1',
  name: 'computer_use',
  arguments: { action: 'click', targetApp: 'Keynote', x: 120, y: 340 },
};

const VISIBLE = ['Bash', 'Read', 'Write', 'computer_use'];

function buildCtx() {
  return {
    sessionId: 'runtime-session-disclosure',
    runId: 'run-1',
    workingDirectory: '/tmp/code-agent-test',
    messages: [{ id: 'user-1', role: 'user', content: '把 Keynote 第 3 页标题改成「2026 年度经营复盘」', timestamp: Date.now() }] as Message[],
    artifact: ArtifactState.forTest(),
    modelConfig: { provider: 'zhipu', model: 'glm-5', maxTokens: 16384 },
    contextHealth: ContextHealthState.forTest({ currentSystemPromptHash: 'hash-1' } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1' } as never),
    turnQualityState: {},
    control: ControlState.forTest({} as never),
    stats: RunStatsState.forTest({ traceId: 'trace-1', totalToolCallCount: 0 } as never),
    nudgeManager: {
      runNudgeChecks: vi.fn(() => false),
      runOutputValidation: vi.fn(() => false),
      getModifiedFiles: vi.fn(() => new Set()),
      trackModifiedFile: vi.fn(),
      checkProgressState: vi.fn(),
      checkPostForceExecute: vi.fn(),
    },
    antiPatternDetector: {
      trackToolFailure: vi.fn(),
      clearToolFailure: vi.fn(),
      trackDuplicateCall: vi.fn(),
      trackFileReread: vi.fn(),
      trackToolExecution: vi.fn(),
      trackReadOnlyShellCommand: vi.fn(),
      isReadOnlyShellCommand: vi.fn().mockReturnValue(false),
      preflightReadOnlyToolExecution: vi.fn().mockReturnValue(null),
      preflightReadOnlyShellCommand: vi.fn().mockReturnValue(null),
      generateHardLimitError: vi.fn(),
    },
    circuitBreaker: {
      recordFailure: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      generateWarningMessage: vi.fn(),
      generateUserErrorMessage: vi.fn(),
    },
    goalTracker: { recordAction: vi.fn() },
    turnTrace: { setTurn: vi.fn(), record: vi.fn(), flush: vi.fn(), getEvents: vi.fn().mockReturnValue([]) },
    onEvent: vi.fn<(event: AgentEvent) => void>(),
    toolExecutor: { execute: vi.fn() },
    telemetryAdapter: {
      onTurnStart: vi.fn(),
      onModelCall: vi.fn(),
      onToolCallStart: vi.fn(),
      onToolCallEnd: vi.fn(),
      onTurnEnd: vi.fn(),
    },
    enableHooks: true,
    enableDeliveryCritic: false,
    maxToolCallRetries: 0,
  };
}

function buildDeps(ctx: { messages: Message[] }, timeline: string[]) {
  const persisted: Message[] = [];
  const contextAssembly = {
    generateId: vi.fn(() => `msg-${persisted.length + 1}`),
    addAndPersistMessage: vi.fn(async (message: Message) => {
      persisted.push(message);
      ctx.messages.push(message);
      if (message.role === 'assistant' && message.toolCalls?.length) timeline.push('persist:assistant-with-toolcalls');
    }),
    injectSystemMessage: vi.fn(),
    pushPersistentSystemContext: vi.fn(),
    stripInternalFormatMimicry: vi.fn((value: string) => value),
    flushHookMessageBuffer: vi.fn(),
    updateContextHealth: vi.fn(),
    checkAndAutoCompress: vi.fn(),
    maybeInjectThinking: vi.fn(),
    getCurrentAttachments: vi.fn(() => []),
    formatArtifactRepairToolResultContent: vi.fn((_r: ToolResult, output: string) => output),
  };
  const runFinalizer = {
    emitTaskProgress: vi.fn(),
    emitTaskComplete: vi.fn(),
    tryParseTodosFromResponse: vi.fn(),
    autoAdvanceTodos: vi.fn(),
  };
  return { contextAssembly, runFinalizer, persisted };
}

const EVENT_PROC = { endSpan: vi.fn() } as never;

describe('GUI 接管披露 · 生产链路（模型一言不发也披露）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);
  });

  it('首次 GUI 驱动调用：披露随消息落库，顺序在 tool_call_start 与 executor 派发之前；同 app 第二次不重复', async () => {
    const timeline: string[] = [];
    const ctx = buildCtx();
    // 真 ToolExecutionEngine；只有最末端的 toolExecutor 外壳是 stub（记录派发顺序）。
    ctx.toolExecutor = {
      execute: vi.fn(async (name: string) => {
        timeline.push(`executor:execute:${name}`);
        return { toolCallId: '', success: true, output: 'ok' };
      }),
    };
    const deps = buildDeps(ctx, timeline);
    const onEvent = vi.fn((event: AgentEvent) => { timeline.push(`event:${event.type}`); });
    ctx.onEvent = onEvent;
    const engine = new ToolExecutionEngine(ctx as unknown as RuntimeContext);
    engine.setModules(
      deps.contextAssembly as never,
      deps.runFinalizer as never,
      { setPlanMode: vi.fn(), isPlanMode: vi.fn().mockReturnValue(false) } as never,
    );
    const processor = new MessageProcessor(
      ctx as unknown as RuntimeContext,
      deps.contextAssembly as unknown as ContextAssembly,
      deps.runFinalizer as unknown as RunFinalizer,
      engine,
    );

    // 模型本轮一言不发：content 为空，直接发工具调用。
    const response = {
      type: 'tool_use',
      content: '',
      toolCalls: [
        { ...KEYNOTE_CLICK },
        { id: 'cu-2', name: 'computer_use', arguments: { action: 'type', targetApp: ' keynote ', text: '2026 年度经营复盘' } },
        { id: 'cu-3', name: 'computer_use', arguments: { action: 'click', targetApp: 'Pages', x: 120, y: 340 } },
      ],
      runtimeDiagnostics: { visibleToolNames: VISIBLE },
    } as unknown as ModelResponse;

    const action = await processor.handleToolResponse(response, false, 1, EVENT_PROC);
    expect(action).toBe('continue');

    // 首条调用带披露；同 app 第二条不重复。
    const assistant = deps.persisted.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    expect(assistant?.toolCalls?.[0]?.guiTakeoverDisclosure).toEqual({ code: 'gui_takeover', app: 'Keynote' });
    expect(assistant?.toolCalls?.[1]?.guiTakeoverDisclosure).toBeUndefined();
    expect(assistant?.toolCalls?.[2]?.guiTakeoverDisclosure).toEqual({ code: 'gui_takeover', app: 'Pages' });

    // tool_call_start 事件同样携带披露（引擎展开整个 toolCall）。
    const startEvent = onEvent.mock.calls.map((c) => c[0]).find((e) => e.type === 'tool_call_start');
    expect(startEvent?.data?.guiTakeoverDisclosure).toEqual({ code: 'gui_takeover', app: 'Keynote' });

    // 顺序：消息落库 → message 事件 → tool_call_start → executor 派发。
    const order = (label: string) => timeline.indexOf(label);
    expect(order('persist:assistant-with-toolcalls')).toBeGreaterThanOrEqual(0);
    expect(order('event:message')).toBeGreaterThan(order('persist:assistant-with-toolcalls'));
    expect(order('event:tool_call_start')).toBeGreaterThan(order('event:message'));
    expect(order('executor:execute:computer_use')).toBeGreaterThan(order('event:tool_call_start'));

    // 落库消息（历史重放源）与事件里的披露一致。
    const messageEvent = onEvent.mock.calls.map((c) => c[0]).find((e) => e.type === 'message');
    expect(messageEvent?.data?.toolCalls?.[0]?.guiTakeoverDisclosure).toEqual({ code: 'gui_takeover', app: 'Keynote' });
  });

  it.each([
    ['screen driver with resolved PID', 'mcp__cua-driver__click', { pid: 123, x: 100, y: 200 }, 'Keynote'],
    ['System Events click', 'Bash', { command: `osascript -e 'tell application "System Events" to tell process "Keynote" to click button 1 of window 1'` }, 'Keynote'],
    ['System Events key press', 'Bash', { command: `osascript -e 'tell application "System Events" to tell process "Keynote" to key code 36'` }, 'Keynote'],
    ['activate', 'Bash', { command: `osascript -e 'tell application "Keynote" to activate'` }, 'Keynote'],
    ['edit open slide', 'Bash', { command: `osascript -e 'tell application "Keynote" to set object text of default title item of slide 3 of front document to "2026 年度经营复盘"'` }, 'Keynote'],
    ['edit nested open slide', 'Bash', { command: `osascript <<'APPLESCRIPT'
tell application "Keynote"
  tell slide 3 of front document
    set object text of default title item to "2026 年度经营复盘"
  end tell
end tell
APPLESCRIPT` }, 'Keynote'],
    ['read-only connector', 'mail', { action: 'list_messages', mailbox: 'Inbox', query: 'Keynote' }, undefined],
    ['Apple Events read', 'Bash', { command: `osascript -e 'tell application "Keynote" to set titleText to name of front document'` }, undefined],
    ['activate as data', 'Bash', { command: `osascript -e 'tell application "Keynote" to get name of every document whose name is "activate"'` }, undefined],
    ['metadata tool', 'mcp__cua-driver__list_apps', {}, undefined],
    ['browser action', 'browser_action', { action: 'navigate', url: 'https://example.com', targetApp: 'Keynote' }, undefined],
  ] as const)('%s carries the expected disclosure through the engine', async (_shape, name, args, app) => {
    const timeline: string[] = [];
    const ctx = buildCtx();
    const onEvent = vi.fn((event: AgentEvent) => { timeline.push(`event:${event.type}`); });
    const log = vi.spyOn(logCollector, 'tool');
    ctx.onEvent = onEvent;
    ctx.toolExecutor = {
      execute: vi.fn(async () => {
        timeline.push('executor:execute');
        return { toolCallId: '', success: true, output: 'ok' };
      }),
    };
    const deps = buildDeps(ctx, timeline);
    const engine = new ToolExecutionEngine(ctx as unknown as RuntimeContext);
    engine.setModules(
      deps.contextAssembly as never,
      deps.runFinalizer as never,
      { setPlanMode: vi.fn(), isPlanMode: vi.fn().mockReturnValue(false) } as never,
    );
    const processor = new MessageProcessor(
      ctx as unknown as RuntimeContext,
      deps.contextAssembly as unknown as ContextAssembly,
      deps.runFinalizer as unknown as RunFinalizer,
      engine,
    );

    try {
      await processor.handleToolResponse({
        type: 'tool_use',
        content: '',
        toolCalls: [{ id: 'gui-case', name, arguments: { ...args } }],
        runtimeDiagnostics: { visibleToolNames: [name] },
      } as unknown as ModelResponse, false, 1, EVENT_PROC);

      const expected = app ? { code: 'gui_takeover', app } : undefined;
      const message = deps.persisted.find((entry) => entry.role === 'assistant' && entry.toolCalls?.length);
      expect(message?.toolCalls?.[0]?.guiTakeoverDisclosure).toEqual(expected);
      const start = onEvent.mock.calls.map(([event]) => event).find((event) => event.type === 'tool_call_start');
      expect(start?.data).toBeDefined();
      expect(start?.data).toMatchObject(expected ? { guiTakeoverDisclosure: expected } : { name });
      if (!expected) expect(start?.data).not.toHaveProperty('guiTakeoverDisclosure');
      expect(timeline.indexOf('executor:execute')).toBeGreaterThan(timeline.indexOf('event:tool_call_start'));
      const decisions = log.mock.calls.filter(([, line]) => line.startsWith('GUI takeover disclosure attached'));
      expect(decisions.map(([, line]) => line)).toEqual(app ? [`GUI takeover disclosure attached (${app})`] : []);
      process.stdout.write(`${_shape}: ${decisions[0]?.[1] ?? 'no disclosure'}\n`);
    } finally {
      log.mockRestore();
    }
  });
});
