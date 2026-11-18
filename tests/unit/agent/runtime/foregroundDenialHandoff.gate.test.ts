// 前台收窄的每一类都必须当场放行，或在同一轮交给生产 delegate_task。
// 豁免：plan-exit 兜底、角色边界、无人值守轮、foregroundToolFace 为 false。
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../../../../src/host/agent/loopTypes';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../../src/host/agent/runtime/runFinalizer';
import type { Message, ToolResult } from '../../../../src/shared/contract';
import type { AgentEvent } from '../../../../src/shared/contract';
import type { TaskManagerEvent } from '../../../../src/host/task/TaskManager';
import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';
import { TurnState } from '../../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../../src/host/agent/runtime/runStatsState';
import { ToolExecutionEngine } from '../../../../src/host/agent/runtime/toolExecutionEngine';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';
import {
  BACKGROUND_HANDOFF_PENDING_REPLY,
  BACKGROUND_HANDOFF_SENTENCE,
} from '../../../../src/host/services/commandCenter/delegationGuidance';
import {
  getToolLedgerSink,
  setToolLedgerSink,
  type ToolLedgerSink,
} from '../../../../src/host/tools/toolLedgerSink';

const logState = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  logger: logState,
  createLogger: () => logState,
}));

vi.mock('../../../../src/host/services', () => ({
  getSessionManager: () => ({ addMessage: vi.fn(), addMessageToSession: vi.fn(), getMessages: vi.fn().mockResolvedValue([]) }),
  getLangfuseService: () => ({ startNestedSpan: vi.fn(), endSpan: vi.fn() }),
  getConfigService: vi.fn(),
  getAuthService: vi.fn(),
  getBudgetService: vi.fn(),
  BudgetAlertLevel: {},
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessage: vi.fn(),
    addMessageToSession: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([{ id: 'user-1', role: 'user', content: 'db-original' }]),
  }),
}));

vi.mock('../../../../src/host/services/git/fileWatcherService', () => ({
  getFileWatcherService: () => ({ getRecentExternalChanges: vi.fn().mockReturnValue([]), markAsAgentModified: vi.fn() }),
}));

vi.mock('../../../../src/host/services/git/gitStatusService', () => ({
  getGitStatusService: () => ({ onPostToolUse: vi.fn() }),
}));

vi.mock('../../../../src/host/services/citation/citationService', () => ({
  getCitationService: () => ({ extractAndStore: vi.fn().mockReturnValue([]) }),
}));

vi.mock('../../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({ getToolAnnotationsMap: () => new Map(), getToolDefinitions: () => [], parseMCPToolName: () => null }),
}));

const taskManagerHolder = vi.hoisted(() => ({ manager: undefined as unknown }));
vi.mock('../../../../src/host/task/TaskManager', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTaskManager: () => taskManagerHolder.manager,
}));

import { MessageProcessor } from '../../../../src/host/agent/runtime/messageProcessor';
import { getTextForegroundToolNamesForPrompt } from '../../../../src/host/app/sessionCommandCenterBrain';
import {
  getSessionCommandCenter,
  resetSessionCommandCenterForTest,
} from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { resetBackgroundTaskLedgerForTest } from '../../../../src/host/task/backgroundTaskLedger';

class FakeTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockResolvedValue(undefined);
  interruptBackgroundTask = vi.fn().mockResolvedValue(true);
  cancelBackgroundTask = vi.fn().mockResolvedValue(true);
  observeAgentEvents(_observer: (sessionId: string, event: AgentEvent, taskId?: string) => void): () => void {
    return () => {};
  }
  emitCancelled(taskId: string, sessionId: string): void {
    this.emit('task_cancelled', { type: 'task_cancelled', sessionId, data: { taskId } } satisfies TaskManagerEvent);
  }
}

const WORKSPACE = createWorkspaceScope('fg-handoff', [{
  sourceId: 'fg-handoff-root',
  path: '/tmp/fg-handoff-project',
  role: 'primary',
  access: 'read_write',
}]);

const ledgerEvents: Array<Record<string, unknown>> = [];
let previousSink: ToolLedgerSink;
const EVENT_PROC = { endSpan: vi.fn() } as never;

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'runtime-session-1',
    runId: 'run-1',
    workingDirectory: '/tmp/code-agent-test',
    messages: [] as Message[],
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
      getModifiedFiles: vi.fn(() => new Set<string>()),
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
    circuitBreaker: { recordFailure: vi.fn().mockReturnValue(false), recordSuccess: vi.fn(), generateWarningMessage: vi.fn(), generateUserErrorMessage: vi.fn() },
    goalTracker: { recordAction: vi.fn() },
    turnTrace: { setTurn: vi.fn(), record: vi.fn(), flush: vi.fn(), getEvents: vi.fn().mockReturnValue([]) },
    onEvent: vi.fn(),
    telemetryAdapter: { onTurnStart: vi.fn(), onModelCall: vi.fn(), onToolCallStart: vi.fn(), onToolCallEnd: vi.fn(), onTurnEnd: vi.fn() },
    toolExecutor: { execute: vi.fn() },
    enableHooks: true,
    enableDeliveryCritic: false,
    maxToolCallRetries: 2,
    ...overrides,
  };
}

function buildDeps(ctx: { messages: Message[] }) {
  const persisted: Message[] = [];
  const injected: string[] = [];
  const contextAssembly = {
    generateId: vi.fn(() => `msg-${persisted.length + 1}`),
    addAndPersistMessage: vi.fn(async (message: Message) => { persisted.push(message); ctx.messages.push(message); }),
    injectSystemMessage: vi.fn((msg: string) => { injected.push(msg); }),
    pushPersistentSystemContext: vi.fn(),
    stripInternalFormatMimicry: vi.fn((value: string) => value),
    flushHookMessageBuffer: vi.fn(),
    updateContextHealth: vi.fn(),
    checkAndAutoCompress: vi.fn(),
    maybeInjectThinking: vi.fn(),
    getCurrentAttachments: vi.fn(() => []),
    formatArtifactRepairToolResultContent: vi.fn((_r: ToolResult, output: string) => output),
  };
  const runFinalizer = { emitTaskProgress: vi.fn(), emitTaskComplete: vi.fn(), tryParseTodosFromResponse: vi.fn(), autoAdvanceTodos: vi.fn() };
  return { contextAssembly, runFinalizer, persisted, injected };
}

function responseOf(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): ModelResponse {
  return { type: 'tool_use', content: '', toolCalls: calls } as unknown as ModelResponse;
}

function prepare(prompt: string, overrides: Record<string, unknown> = {}) {
  const ctx = buildCtx({
    foregroundToolFace: true,
    workspaceScope: WORKSPACE,
    allowedToolNames: getTextForegroundToolNamesForPrompt(prompt),
    messages: [{ id: 'user-1', role: 'user', content: prompt, timestamp: Date.now() }] as Message[],
    ...overrides,
  });
  (ctx.turn as TurnState).beginRun(prompt);
  (ctx.turn as TurnState).beginTurn('turn-1', 'iteration-1');
  return ctx;
}

function assistantTexts(ctx: { onEvent: ReturnType<typeof vi.fn> }): string[] {
  return ctx.onEvent.mock.calls
    .map(([event]) => event as { type: string; data: Message })
    .filter((event) => event.type === 'message' && event.data.role === 'assistant' && !event.data.toolCalls?.length)
    .map((event) => event.data.content);
}

describe('foreground narrowing gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionCommandCenterForTest();
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
    taskManagerHolder.manager = new FakeTaskManager();
    previousSink = getToolLedgerSink();
    ledgerEvents.length = 0;
    setToolLedgerSink({
      appendPermissionDecision: () => {},
      appendToolExecutionBegin: (input) => { ledgerEvents.push({ phase: 'begin', ...input }); },
      appendToolExecutionComplete: (input) => { ledgerEvents.push({ phase: 'complete', ...input }); },
    });
  });

  afterEach(() => {
    setToolLedgerSink(previousSink);
    resetSessionCommandCenterForTest();
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
  });

  it.each([
    ['ExcelAutomate read', '工作区里有一份物业服务合同的 Excel，帮我说明一下这份合同讲了什么。',
      { id: 'xl-read', name: 'ExcelAutomate', arguments: { action: 'list_sheets', file_path: '/tmp/a.xlsx' } }, 'admit'],
    ['ExcelAutomate non-read', '把这份物业服务合同的 Excel 里的公式改写一下。',
      { id: 'xl-edit', name: 'ExcelAutomate', arguments: { action: 'edit', file_path: '/tmp/a.xlsx' } }, 'handoff'],
    ['Bash', '明天上午 9 点提醒我交报告，请用 Bash 执行多行 osascript 建提醒',
      { id: 'bash-1', name: 'Bash', arguments: { command: 'osascript' } }, 'handoff'],
    ['browser', '请用 Browser 打开这个页面看一下标题',
      { id: 'br-1', name: 'Browser', arguments: { url: 'https://example.com' } }, 'handoff'],
    ['computer_use', '请用 computer_use 看一下屏幕',
      { id: 'cu-1', name: 'computer_use', arguments: {} }, 'handoff'],
  ] as const)('%s：拒绝后同一轮交给 delegate_task，或工具被放行', async (_label, prompt, call, expected) => {
    const ctx = prepare(prompt);
    const deps = buildDeps(ctx);
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async (): Promise<ToolResult[]> => [
        { toolCallId: call.id, success: true, output: 'ok', duration: 1 },
      ]),
    };
    const processor = new MessageProcessor(
      ctx as unknown as RuntimeContext,
      deps.contextAssembly as unknown as ContextAssembly,
      deps.runFinalizer as unknown as RunFinalizer,
      toolEngine as unknown as ToolExecutionEngine,
    );

    const action = await processor.handleToolResponse(responseOf([call]), false, 1, EVENT_PROC);
    const tasks = getSessionCommandCenter().list(ctx.sessionId);

    if (expected === 'admit') {
      expect(action).toBe('continue');
      expect(toolEngine.executeToolsWithHooks).toHaveBeenCalledTimes(1);
      expect(tasks).toHaveLength(0);
      expect(deps.injected).toHaveLength(0);
      expect(logState.info.mock.calls.map(([line]) => line)).not.toContain('Foreground denial handed off in the same turn');
      return;
    }

    expect(action).toBe('break');
    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
    expect(deps.injected).toHaveLength(0);
    expect(assistantTexts(ctx)).toEqual([BACKGROUND_HANDOFF_SENTENCE]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.prompt).toContain(prompt);
    // 规则句里会提到这个标签；真正的包裹标签后面是换行。包两次会有两个换行标签。
    expect(tasks[0]?.prompt.match(/<drafted_task_plan>\n/g)).toHaveLength(1);
    expect(tasks[0]?.prompt.match(/<original_user_request /g)).toHaveLength(1);
    expect(tasks[0]?.toolCallId).toBe('host-handoff:turn-1');
    const sealed = deps.persisted.find((message) => message.role === 'tool')?.toolResults?.[0];
    expect(sealed?.metadata).toMatchObject({ code: 'TOOL_DISABLED_FOR_RUN', bounced: true });
    expect(ledgerEvents.some((row) => row.phase === 'begin' && row.toolName === 'delegate_task' && row.toolCallId === 'host-handoff:turn-1')).toBe(true);
    expect(logState.info.mock.calls.map(([line]) => line)).toContain('Foreground denial handed off in the same turn');
  });

  // plan-exit 兜底：写工具被兜底窗口拦住，不因「可交后台」改道。
  it('plan-exit fallback does not hand off', async () => {
    const prompt = '把标题改成新的';
    const ctx = prepare(prompt, { control: ControlState.forTest({ planExitFallbackActive: true } as never) });
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn(), runtimeControl: { isPlanMode: () => true } };
    const processor = new MessageProcessor(ctx as unknown as RuntimeContext, deps.contextAssembly as unknown as ContextAssembly, deps.runFinalizer as unknown as RunFinalizer, toolEngine as unknown as ToolExecutionEngine);
    await processor.handleToolResponse(responseOf([
      { id: 'write-1', name: 'Write', arguments: { file_path: '/tmp/a.txt', content: 'x' } },
    ]), false, 1, EVENT_PROC);
    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
    expect(getSessionCommandCenter().list(ctx.sessionId)).toHaveLength(0);
    expect(deps.persisted.find((message) => message.role === 'tool')?.toolResults?.[0]?.metadata?.code).toBe('TOOL_DISABLED_FOR_RUN');
    expect(assistantTexts(ctx)).not.toContain(BACKGROUND_HANDOFF_SENTENCE);
  });

  // 角色边界最后减：dream 没有 Bash。即便 delegate_task 在本轮附加名单里，也不交接。
  it('role boundary does not hand off', async () => {
    const prompt = '明天上午 9 点提醒我交报告，请用 Bash 执行多行 osascript 建提醒';
    const ctx = prepare(prompt, { agentId: 'dream', maxToolCallRetries: 0 });
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn() };
    const processor = new MessageProcessor(ctx as unknown as RuntimeContext, deps.contextAssembly as unknown as ContextAssembly, deps.runFinalizer as unknown as RunFinalizer, toolEngine as unknown as ToolExecutionEngine);
    await processor.handleToolResponse(responseOf([
      { id: 'bash-role', name: 'Bash', arguments: { command: 'osascript' } },
    ]), false, 1, EVENT_PROC);
    expect(getSessionCommandCenter().list(ctx.sessionId)).toHaveLength(0);
    expect(assistantTexts(ctx)).not.toContain(BACKGROUND_HANDOFF_SENTENCE);
  });

  // 无人值守轮没有人收后台结果，不交接。
  it('unattended turn does not hand off', async () => {
    const prompt = '明天上午 9 点提醒我交报告，请用 Bash 执行多行 osascript 建提醒';
    const ctx = prepare(prompt, { unattendedTurn: true, maxToolCallRetries: 0 });
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn() };
    const processor = new MessageProcessor(ctx as unknown as RuntimeContext, deps.contextAssembly as unknown as ContextAssembly, deps.runFinalizer as unknown as RunFinalizer, toolEngine as unknown as ToolExecutionEngine);
    await processor.handleToolResponse(responseOf([
      { id: 'bash-unattended', name: 'Bash', arguments: { command: 'osascript' } },
    ]), false, 1, EVENT_PROC);
    expect(getSessionCommandCenter().list(ctx.sessionId)).toHaveLength(0);
    expect(assistantTexts(ctx)).not.toContain(BACKGROUND_HANDOFF_SENTENCE);
  });

  // foregroundToolFace 为 false 时沿用运行级拒绝，不在这一轮创建后台任务。
  it('non-foreground face does not hand off', async () => {
    const prompt = '明天上午 9 点提醒我交报告，请用 Bash 执行多行 osascript 建提醒';
    const ctx = prepare(prompt, { foregroundToolFace: false, maxToolCallRetries: 0 });
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn() };
    const processor = new MessageProcessor(ctx as unknown as RuntimeContext, deps.contextAssembly as unknown as ContextAssembly, deps.runFinalizer as unknown as RunFinalizer, toolEngine as unknown as ToolExecutionEngine);
    await processor.handleToolResponse(responseOf([
      { id: 'bash-bg', name: 'Bash', arguments: { command: 'osascript' } },
    ]), false, 1, EVENT_PROC);
    expect(getSessionCommandCenter().list(ctx.sessionId)).toHaveLength(0);
    expect(assistantTexts(ctx)).not.toContain(BACKGROUND_HANDOFF_SENTENCE);
  });

  it('uses the run-scoped executor workspace when the runtime has no project scope', async () => {
    const prompt = '明天上午 9 点提醒我交报告，请用 Bash 执行多行 osascript 建提醒';
    const ctx = prepare(prompt, {
      workspaceScope: undefined,
      toolExecutor: {
        execute: vi.fn(),
        getRunContext: () => ({ workspace: WORKSPACE.primaryRoot, workspaceScope: WORKSPACE }),
      },
    });
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn() };
    const processor = new MessageProcessor(ctx as unknown as RuntimeContext, deps.contextAssembly as unknown as ContextAssembly, deps.runFinalizer as unknown as RunFinalizer, toolEngine as unknown as ToolExecutionEngine);
    const action = await processor.handleToolResponse(responseOf([
      { id: 'bash-run-scope', name: 'Bash', arguments: { command: 'osascript' } },
    ]), false, 1, EVENT_PROC);
    expect(action).toBe('break');
    expect(assistantTexts(ctx)).toEqual([BACKGROUND_HANDOFF_SENTENCE]);
    expect(getSessionCommandCenter().list(ctx.sessionId)).toHaveLength(1);
    expect(deps.injected).toHaveLength(0);
    expect(logState.info.mock.calls.map(([line]) => line)).toContain('Foreground denial handed off in the same turn');
  });

  it('delegate handler failure keeps the guidance path and the pending reply', async () => {
    const prompt = '明天上午 9 点提醒我交报告，请用 Bash 执行多行 osascript 建提醒';
    const ctx = prepare(prompt, { workspaceScope: undefined, maxToolCallRetries: 0 });
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn() };
    const processor = new MessageProcessor(ctx as unknown as RuntimeContext, deps.contextAssembly as unknown as ContextAssembly, deps.runFinalizer as unknown as RunFinalizer, toolEngine as unknown as ToolExecutionEngine);
    const action = await processor.handleToolResponse(responseOf([
      { id: 'bash-fail', name: 'Bash', arguments: { command: 'osascript' } },
    ]), false, 1, EVENT_PROC);
    expect(action).toBe('break');
    expect(getSessionCommandCenter().list(ctx.sessionId)).toHaveLength(0);
    expect(deps.injected.join('\n')).toContain('requested method');
    expect(deps.injected.join('\n')).toContain(BACKGROUND_HANDOFF_SENTENCE);
    expect(assistantTexts(ctx)).toEqual([BACKGROUND_HANDOFF_PENDING_REPLY]);
    expect(logState.warn.mock.calls.map(([line]) => line)).toContain('Foreground denial handoff failed');
    expect(ledgerEvents.filter((row) => row.toolName === 'delegate_task')).toHaveLength(0);
  });
});
