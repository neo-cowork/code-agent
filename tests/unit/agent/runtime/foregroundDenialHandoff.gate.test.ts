// 前台收窄的每一类都必须当场放行，或在同一轮交给生产 delegate_task。
// 豁免：plan-exit 兜底、角色边界、无人值守轮、foregroundToolFace 为 false。
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../../../../src/host/agent/loopTypes';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../../src/host/agent/runtime/runFinalizer';
import type { Message, ToolCall, ToolResult } from '../../../../src/shared/contract';
import type { AgentEvent } from '../../../../src/shared/contract';
import type { TaskManagerEvent } from '../../../../src/host/task/TaskManager';
import { settleForegroundToolDenial } from '../../../../src/host/agent/runtime/foregroundDenialHandoff';
import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';
import { TurnState } from '../../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../../src/host/agent/runtime/runStatsState';
import { ToolExecutionEngine } from '../../../../src/host/agent/runtime/toolExecutionEngine';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';
import { createRunContext } from '../../../../src/host/runtime/runContext';
import { getDefaultWorkDirectory } from '../../../../src/host/config/configPaths';
import { ToolExecutor } from '../../../../src/host/tools/toolExecutor';
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

import { getPermissionModeManager, resetPermissionModeManager } from '../../../../src/host/permissions/modes';
import { MessageProcessor } from '../../../../src/host/agent/runtime/messageProcessor';
import { getTextForegroundToolNamesForPrompt } from '../../../../src/host/app/sessionCommandCenterBrain';
import {
  getSessionCommandCenter,
  resetSessionCommandCenterForTest,
} from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import {
  getSessionTaskConcurrencyPool,
  resetSessionTaskConcurrencyPoolForTest,
} from '../../../../src/host/services/commandCenter/sessionTaskSlotLedger';
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
    expect(sealed?.metadata).toMatchObject({ code: 'HANDED_OFF_TO_BACKGROUND', bounced: true, skipped: true });
    expect(ledgerEvents.some((row) => row.phase === 'begin' && row.toolName === 'delegate_task' && row.toolCallId === 'host-handoff:turn-1')).toBe(true);
    expect(logState.info.mock.calls.map(([line]) => line)).toContain('Foreground denial handed off in the same turn');
  });

  // 全权限（bypassPermissions）会话：前台工具面不含 Bash / 非读 Excel（ADR-059），拒绝与权限档无关。
  // 交接成功后封口码必须是 HANDED_OFF_TO_BACKGROUND；交接失败仍是 TOOL_DISABLED_FOR_RUN。
  describe('bypassPermissions session', () => {
    beforeEach(() => {
      resetPermissionModeManager();
      getPermissionModeManager().setMode('bypassPermissions', true, 'external');
    });
    afterEach(() => resetPermissionModeManager());

    it.each([
      ['Bash', { id: 'bp-bash', name: 'Bash', arguments: { command: 'ls' } }],
      ['non-read ExcelAutomate', { id: 'bp-xl', name: 'ExcelAutomate', arguments: { action: 'edit', file_path: '/tmp/a.xlsx' } }],
    ] as const)('%s: handed off, sealed with the handed-off code, not TOOL_DISABLED_FOR_RUN', async (_label, call) => {
      const prompt = '把这份表格和会议记录做成演示稿和纪要，成品都存到同一目录：/tmp/out';
      const ctx = prepare(prompt);
      expect(getPermissionModeManager().getModeForSession(ctx.sessionId)).toBe('bypassPermissions');
      const deps = buildDeps(ctx);
      const toolEngine = { executeToolsWithHooks: vi.fn() };
      const processor = new MessageProcessor(ctx as unknown as RuntimeContext, deps.contextAssembly as unknown as ContextAssembly, deps.runFinalizer as unknown as RunFinalizer, toolEngine as unknown as ToolExecutionEngine);
      const action = await processor.handleToolResponse(responseOf([call]), false, 1, EVENT_PROC);
      expect(action).toBe('break');
      const sealed = deps.persisted.find((message) => message.role === 'tool')?.toolResults?.[0];
      expect(sealed?.metadata?.code).toBe('HANDED_OFF_TO_BACKGROUND');
      expect(JSON.stringify(sealed)).not.toContain('TOOL_DISABLED_FOR_RUN');
      expect(logState.info.mock.calls.map(([line]) => line)).toContain('Foreground denial handed off in the same turn');
    });

    it('a same-batch sibling skipped by the handoff is also sealed as handed off', async () => {
      const prompt = '把这份表格做成演示稿，成品都存到同一目录：/tmp/out';
      const ctx = prepare(prompt);
      const deps = buildDeps(ctx);
      const toolEngine = { executeToolsWithHooks: vi.fn() };
      const processor = new MessageProcessor(ctx as unknown as RuntimeContext, deps.contextAssembly as unknown as ContextAssembly, deps.runFinalizer as unknown as RunFinalizer, toolEngine as unknown as ToolExecutionEngine);
      await processor.handleToolResponse(responseOf([
        { id: 'sib-bash', name: 'Bash', arguments: { command: 'ls' } },
        { id: 'sib-read', name: 'Read', arguments: { file_path: '/tmp/a.csv' } },
      ]), false, 1, EVENT_PROC);
      const results = deps.persisted.find((message) => message.role === 'tool')?.toolResults ?? [];
      expect(results.map((r) => r.metadata?.code)).toEqual(['HANDED_OFF_TO_BACKGROUND', 'HANDED_OFF_TO_BACKGROUND']);
    });

    it('failed handoff keeps TOOL_DISABLED_FOR_RUN', async () => {
      const prompt = '明天上午 9 点提醒我交报告，请用 Bash 执行多行 osascript 建提醒';
      const ctx = prepare(prompt, { workspaceScope: undefined, maxToolCallRetries: 0 });
      const deps = buildDeps(ctx);
      const toolEngine = { executeToolsWithHooks: vi.fn() };
      const processor = new MessageProcessor(ctx as unknown as RuntimeContext, deps.contextAssembly as unknown as ContextAssembly, deps.runFinalizer as unknown as RunFinalizer, toolEngine as unknown as ToolExecutionEngine);
      await processor.handleToolResponse(responseOf([
        { id: 'bp-fail', name: 'Bash', arguments: { command: 'osascript' } },
      ]), false, 1, EVENT_PROC);
      const sealed = deps.persisted.find((message) => message.role === 'tool')?.toolResults?.[0];
      expect(sealed?.metadata?.code).toBe('TOOL_DISABLED_FOR_RUN');
    });
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

  // 收窄范围与执行意图必须随交接下传（与 toolExecutionEngine 生产路径同形）：
  // 用户把工作台收窄到某几个连接器 / MCP 后，主机派出的后台任务不能比模型自己调
  // delegate_task 时拿到的范围更宽。
  it('hands the workbench tool scope and execution intent to the background task', async () => {
    const prompt = '明天上午 9 点提醒我交报告，请用 Bash 执行多行 osascript 建提醒';
    const toolScope = { allowedConnectorIds: ['connector-a'], allowedMcpServerIds: ['mcp-a'] };
    const executionIntent = { allowParallelPlanPreview: true };
    const ctx = prepare(prompt, { toolScope, executionIntent });
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn() };
    const processor = new MessageProcessor(ctx as unknown as RuntimeContext, deps.contextAssembly as unknown as ContextAssembly, deps.runFinalizer as unknown as RunFinalizer, toolEngine as unknown as ToolExecutionEngine);
    const action = await processor.handleToolResponse(responseOf([
      { id: 'bash-scope', name: 'Bash', arguments: { command: 'osascript' } },
    ]), false, 1, EVENT_PROC);
    expect(action).toBe('break');
    const tasks = getSessionCommandCenter().list(ctx.sessionId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.options?.toolScope).toEqual(toolScope);
    expect(tasks[0]?.options?.executionIntent).toEqual(executionIntent);
  });

  // 交接标题保留词间空格：折叠空白为单个空格、截 24 个码点、去掉尾部空格。
  // 英文请求不能再粘成 Runoneshell… 这样的不可读串（前台拒绝同轮交接的任务名）。
  describe('handoff title keeps word spaces', () => {
    async function titleFromHandoff(prompt: string): Promise<string> {
      const ctx = prepare(prompt);
      const deps = buildDeps(ctx);
      const toolEngine = { executeToolsWithHooks: vi.fn() };
      const processor = new MessageProcessor(
        ctx as unknown as RuntimeContext,
        deps.contextAssembly as unknown as ContextAssembly,
        deps.runFinalizer as unknown as RunFinalizer,
        toolEngine as unknown as ToolExecutionEngine,
      );
      const action = await processor.handleToolResponse(responseOf([
        { id: 'bash-title', name: 'Bash', arguments: { command: 'ls' } },
      ]), false, 1, EVENT_PROC);
      expect(action).toBe('break');
      const tasks = getSessionCommandCenter().list(ctx.sessionId);
      expect(tasks).toHaveLength(1);
      return tasks[0]?.title ?? '';
    }

    it('english request keeps single spaces, <=24 code points, no glued run', async () => {
      const title = await titleFromHandoff('Run one shell command that watches the downloads folder');
      expect(title).toBe('Run one shell command th');
      expect(Array.from(title).length).toBeLessThanOrEqual(24);
      expect(title).toContain(' ');
      expect(title).not.toContain('Runoneshell');
    });

    it('pure chinese prompt keeps its first 24 code points unchanged', async () => {
      const prompt = '请帮我整理项目根目录下面的所有临时文件并且把结果汇总成一份简短的报告发给我';
      const title = await titleFromHandoff(prompt);
      expect(title).toBe(Array.from(prompt).slice(0, 24).join(''));
    });

    it('mixed zh/en prompt keeps single spaces around latin words', async () => {
      const title = await titleFromHandoff('帮我把 README 里面的安装步骤   翻译成英文，然后写到 notes.txt');
      expect(title).toBe('帮我把 README 里面的安装步骤 翻译成英文');
      expect(Array.from(title).length).toBeLessThanOrEqual(24);
    });

    it('newlines, tabs and space runs collapse to single spaces without edge spaces', async () => {
      const title = await titleFromHandoff('  Run\tone  shell\ncommand  that   watches\tthe folder  ');
      expect(title).toBe('Run one shell command th');
      expect(title.startsWith(' ')).toBe(false);
      expect(title.endsWith(' ')).toBe(false);
      expect(title).not.toMatch(/\s{2,}/);
    });

    it('a cut falling on a space does not leave a trailing space', async () => {
      const title = await titleFromHandoff('Weekly sync notes for q 403 review please');
      expect(title).toBe('Weekly sync notes for q');
      expect(title.endsWith(' ')).toBe(false);
    });
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

  // 没选文件夹的会话（「未分类」）：从生产入口 settleForegroundToolDenial 进，用用户的原话和多行 osascript heredoc。
  // 运行时上下文上没有 Project Source，工作目录只有 run 级执行器知道（无文件夹首轮只规划路径，盘上还没建）。
  describe('no-folder session through settleForegroundToolDenial', () => {
    const NO_FOLDER_PROMPT = '明天上午 9 点提醒我交报告。请用 Bash 工具执行多行 osascript（heredoc）建提醒';
    const OSA_HEREDOC = [
      "osascript <<'EOF'",
      'set dueDate to current date',
      'set time of dueDate to 0',
      'set dueDate to dueDate + (days * 1)',
      'set time of dueDate to 9 * hours',
      'tell application "Reminders"',
      '    make new reminder with properties {name:"交报告", remind me date:dueDate}',
      'end tell',
      'EOF',
    ].join('\n');
    const BASH_CALL: ToolCall = {
      id: 'bash-nofolder',
      name: 'Bash',
      arguments: { command: OSA_HEREDOC, description: '用 osascript 创建明早 9 点交报告提醒' },
    } as ToolCall;

    function noFolderCtx(workRoot: string, overrides: Record<string, unknown> = {}) {
      const runContext = createRunContext({
        runId: 'run-nofolder-1',
        sessionId: 'runtime-nofolder-1',
        workspace: workRoot,
        cwd: workRoot,
      });
      const toolExecutor = new ToolExecutor({
        requestPermission: async () => true,
        workingDirectory: runContext.cwd,
        runContext,
      });
      toolExecutor.setAuditEnabled(false);
      const ctx = buildCtx({
        sessionId: runContext.sessionId,
        runId: runContext.runId,
        foregroundToolFace: true,
        workspaceScope: undefined,
        workingDirectory: runContext.cwd,
        toolExecutor,
        allowedToolNames: getTextForegroundToolNamesForPrompt(NO_FOLDER_PROMPT),
        messages: [{ id: 'user-1', role: 'user', content: NO_FOLDER_PROMPT, timestamp: Date.now() }] as Message[],
        ...overrides,
      });
      (ctx.turn as TurnState).beginRun(NO_FOLDER_PROMPT);
      (ctx.turn as TurnState).beginTurn('turn-1', 'iteration-1');
      return { ctx, runContext };
    }

    function settle(ctx: ReturnType<typeof buildCtx>, deps: ReturnType<typeof buildDeps>) {
      return settleForegroundToolDenial({
        ctx: ctx as unknown as RuntimeContext,
        contextAssembly: deps.contextAssembly as unknown as ContextAssembly,
        guard: { toolCallRetryCount: 0 },
        response: responseOf([BASH_CALL]),
        toolCalls: [BASH_CALL],
        planModeActive: () => false,
      });
    }

    function sealedResult(deps: ReturnType<typeof buildDeps>): ToolResult | undefined {
      return deps.persisted.find((message) => message.role === 'tool')?.toolResults?.[0];
    }

    it.each([
      ['planned session folder under the default work root', (root: string) => path.join(root, '任务_1125_明天上午 9 点提醒我交报告')],
      ['the default work root itself', (root: string) => root],
    ])('hands off in the same turn when the workspace is %s', async (_label, workRootOf) => {
      const workRoot = workRootOf(getDefaultWorkDirectory());
      const { ctx, runContext } = noFolderCtx(workRoot);
      const deps = buildDeps(ctx);

      const action = await settle(ctx, deps);

      expect(action).toBe('break');
      expect(assistantTexts(ctx)).toEqual([BACKGROUND_HANDOFF_SENTENCE]);
      expect(deps.injected).toHaveLength(0);
      const tasks = getSessionCommandCenter().list(ctx.sessionId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.status).toBe('running');
      expect(tasks[0]?.workspaceScope.primaryRoot).toBe(runContext.workspace);
      expect(tasks[0]?.prompt).toContain(NO_FOLDER_PROMPT);
      expect(tasks[0]?.toolCallId).toBe('host-handoff:turn-1');
      expect(sealedResult(deps)).toMatchObject({
        toolCallId: 'bash-nofolder',
        success: false,
        error: 'HANDED_OFF_TO_BACKGROUND',
        metadata: { code: 'HANDED_OFF_TO_BACKGROUND', bounced: true, skipped: true },
      });
      expect(ledgerEvents.some((row) => row.phase === 'begin' && row.toolName === 'delegate_task' && row.toolCallId === 'host-handoff:turn-1')).toBe(true);
      const lines = logState.warn.mock.calls.map(([line]) => line);
      expect(lines).not.toContain('Foreground denial handoff failed');
      expect(logState.info.mock.calls.map(([line]) => line)).toContain('Foreground denial handed off in the same turn');
    });

    // 并发池被别的会话占满：主机交接后面没有模型轮次去转述「排队 / 替换 / 暂不创建」，
    // 所以直接排队。任务必须真的在台账里，收尾才能说「交给后台任务了」。
    it('queues the task when the shared task pool is already full, instead of asking a question nobody answers', async () => {
      const pool = getSessionTaskConcurrencyPool();
      for (let index = 0; index < pool.globalLimit; index += 1) {
        expect(pool.acquire(`other-session-task-${index}`)).toBe(true);
      }
      const { ctx } = noFolderCtx(getDefaultWorkDirectory());
      const deps = buildDeps(ctx);

      const action = await settle(ctx, deps);

      expect(action).toBe('break');
      const tasks = getSessionCommandCenter().list(ctx.sessionId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.status).toBe('queued');
      expect((taskManagerHolder.manager as FakeTaskManager).startBackgroundTask).not.toHaveBeenCalled();
      expect(assistantTexts(ctx)).toEqual([BACKGROUND_HANDOFF_SENTENCE]);
      expect(deps.persisted.map((message) => message.content).join('\n')).not.toContain('尚未创建');
      expect(sealedResult(deps)?.metadata?.code).toBe('HANDED_OFF_TO_BACKGROUND');
      expect(logState.warn.mock.calls.map(([line]) => line)).not.toContain('Foreground denial handoff failed');
    });

    // delegate_task 的「尚未创建」回执也是 ok：没有任务就不能说交接成功，回到原有的指引路径。
    it('keeps the guidance path when delegate_task answers ok without creating a task', async () => {
      const spawn = vi.spyOn(getSessionCommandCenter(), 'spawn')
        .mockResolvedValue({ outcome: 'requires_choice', active: [] });
      const { ctx } = noFolderCtx(getDefaultWorkDirectory(), { maxToolCallRetries: 0 });
      const deps = buildDeps(ctx);

      const action = await settle(ctx, deps);

      spawn.mockRestore();
      expect(action).toBe('break');
      expect(getSessionCommandCenter().list(ctx.sessionId)).toHaveLength(0);
      expect(assistantTexts(ctx)).not.toContain(BACKGROUND_HANDOFF_SENTENCE);
      expect(assistantTexts(ctx).at(-1)).toBe(BACKGROUND_HANDOFF_PENDING_REPLY);
      expect(sealedResult(deps)?.metadata?.code).toBe('TOOL_DISABLED_FOR_RUN');
      expect(logState.warn.mock.calls).toContainEqual(['Foreground denial handoff failed', expect.objectContaining({ code: 'TASK_NOT_CREATED' })]);
      expect(ledgerEvents.filter((row) => row.toolName === 'delegate_task')).toHaveLength(0);
    });
  });
});
