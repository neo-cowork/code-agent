// ============================================================================
// declare_deliverables 不得吞掉整批调用：经生产入口 MessageProcessor.handleToolResponse，
// 声明只记账，调用与结果落库，同批其他工具照常执行；goal 闸 / 修复闸打回时也要补账。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../../../src/host/agent/loopTypes';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { Message, ToolResult } from '../../../src/shared/contract';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

const sessionManagerState = vi.hoisted(() => ({
  addMessage: vi.fn(),
  addMessageToSession: vi.fn(),
}));

const gameValidatorState = vi.hoisted(() => ({ validateGameArtifact: vi.fn() }));
vi.mock('../../../src/host/agent/runtime/gameArtifactValidator', () => ({
  validateGameArtifact: gameValidatorState.validateGameArtifact,
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
  getLangfuseService: () => ({ startNestedSpan: vi.fn(), endSpan: vi.fn() }),
  getConfigService: vi.fn(),
  getAuthService: vi.fn(),
  getBudgetService: vi.fn(),
  BudgetAlertLevel: {},
}));

vi.mock('../../../src/host/services/git/fileWatcherService', () => ({
  getFileWatcherService: () => ({
    getRecentExternalChanges: vi.fn().mockReturnValue([]),
    markAsAgentModified: vi.fn(),
  }),
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
    parseMCPToolName: () => null,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: {
    agent: vi.fn(),
    tool: vi.fn(),
    browser: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { executeDeclareDeliverables } from '../../../src/host/tools/modules/planning/declareDeliverables';
import { MessageProcessor } from '../../../src/host/agent/runtime/messageProcessor';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';

const DECLARE_CALL = { id: 'dd-1', name: 'declare_deliverables', arguments: { final_artifacts: ['/tmp/code-agent-test/brief.md'] } };
const SEARCH_CALL = { id: 'ws-1', name: 'WebSearch', arguments: { query: 'remote collaboration tools' } };
const COMPLETE_CALL = { id: 'ac-1', name: 'attempt_completion', arguments: { summary: 'done' } };
const VISIBLE = ['Bash', 'Read', 'Write', 'WebSearch', 'declare_deliverables', 'attempt_completion'];

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'runtime-session-1',
    runId: 'run-1',
    workingDirectory: '/tmp/code-agent-test',
    messages: [{ id: 'user-1', role: 'user', content: '打开 example.com 看看标题', timestamp: Date.now() }] as Message[],
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
    circuitBreaker: {
      recordFailure: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      generateWarningMessage: vi.fn(),
      generateUserErrorMessage: vi.fn(),
    },
    goalTracker: { recordAction: vi.fn() },
    turnTrace: { setTurn: vi.fn(), record: vi.fn(), flush: vi.fn(), getEvents: vi.fn().mockReturnValue([]) },
    onEvent: vi.fn(),
    telemetryAdapter: {
      onTurnStart: vi.fn(),
      onModelCall: vi.fn(),
      onToolCallStart: vi.fn(),
      onToolCallEnd: vi.fn(),
      onTurnEnd: vi.fn(),
    },
    toolExecutor: { execute: vi.fn() },
    enableHooks: true,
    enableDeliveryCritic: false,
    maxToolCallRetries: 0,
    ...overrides,
  };
}

function buildDeps(ctx: { messages: Message[] }) {
  const persisted: Message[] = [];
  const injected: string[] = [];
  const contextAssembly = {
    generateId: vi.fn(() => `msg-${persisted.length + 1}`),
    addAndPersistMessage: vi.fn(async (message: Message) => {
      persisted.push(message);
      ctx.messages.push(message);
    }),
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
  const runFinalizer = {
    emitTaskProgress: vi.fn(),
    emitTaskComplete: vi.fn(),
    tryParseTodosFromResponse: vi.fn(),
    autoAdvanceTodos: vi.fn(),
  };
  return { contextAssembly, runFinalizer, persisted, injected };
}

function makeProcessor(
  ctx: Record<string, unknown>,
  deps: ReturnType<typeof buildDeps>,
  toolEngine: unknown,
): MessageProcessor {
  return new MessageProcessor(
    ctx as unknown as RuntimeContext,
    deps.contextAssembly as unknown as ContextAssembly,
    deps.runFinalizer as unknown as RunFinalizer,
    toolEngine as ToolExecutionEngine,
  );
}

function toolUseResponse(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
  return {
    type: 'tool_use',
    content: '',
    toolCalls: calls,
    runtimeDiagnostics: { visibleToolNames: VISIBLE },
  } as unknown as ModelResponse;
}

/** 真 ToolExecutionEngine + 真 declare_deliverables executor，只有最末端的 toolExecutor 外壳是 stub。 */
function makeRealEngine(ctx: Record<string, unknown>, deps: ReturnType<typeof buildDeps>) {
  ctx.toolExecutor = {
    execute: vi.fn(async (_name: string, args: Record<string, unknown>, toolCtx: Record<string, unknown>) => {
      const r = await executeDeclareDeliverables(args, toolCtx as never, (async () => ({ allowed: true })) as never);
      return r.ok
        ? { toolCallId: '', success: true, output: r.output }
        : { toolCallId: '', success: false, error: r.error };
    }),
  };
  const engine = new ToolExecutionEngine(ctx as unknown as RuntimeContext);
  engine.setModules(
    deps.contextAssembly as never,
    deps.runFinalizer as never,
    { setPlanMode: vi.fn(), isPlanMode: vi.fn().mockReturnValue(false) } as never,
  );
  return engine;
}

const EVENT_PROC = { endSpan: vi.fn() } as never;

describe('declare_deliverables 不吞整批', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);
  });

  it('declare + WebSearch 同批：WebSearch 照常执行，两条结果都落库，声明已记录', async () => {
    const ctx = buildCtx();
    const deps = buildDeps(ctx);
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async (): Promise<ToolResult[]> => [
        { toolCallId: 'dd-1', success: true, output: 'executor fallback', duration: 1 },
        { toolCallId: 'ws-1', success: true, output: 'search hits', duration: 5 },
      ]),
    };
    const processor = makeProcessor(ctx, deps, toolEngine);

    const action = await processor.handleToolResponse(toolUseResponse([DECLARE_CALL, SEARCH_CALL]), false, 1, EVENT_PROC);

    expect(action).toBe('continue');
    expect(toolEngine.executeToolsWithHooks).toHaveBeenCalledWith([DECLARE_CALL, SEARCH_CALL]);
    expect((ctx.artifact as ArtifactState).declaredDeliverables?.finalArtifacts).toEqual(['/tmp/code-agent-test/brief.md']);
    const assistant = deps.persisted.find((m) => m.role === 'assistant');
    expect(assistant?.toolCalls?.map((c) => c.name)).toEqual(['declare_deliverables', 'WebSearch']);
    const results = deps.persisted.find((m) => m.role === 'tool')?.toolResults ?? [];
    expect(results.find((r) => r.toolCallId === 'dd-1')).toMatchObject({ success: true });
    expect(results.find((r) => r.toolCallId === 'dd-1')?.output).toContain('已记录最终产物声明');
    expect(results.find((r) => r.toolCallId === 'ws-1')).toMatchObject({ success: true, output: 'search hits' });
  });

  it('declare 单独调用：有 tool result，下一轮模型上下文里能看到这次调用', async () => {
    const ctx = buildCtx();
    const deps = buildDeps(ctx);
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async (): Promise<ToolResult[]> => [
        { toolCallId: 'dd-1', success: true, output: 'executor fallback', duration: 1 },
      ]),
    };
    const processor = makeProcessor(ctx, deps, toolEngine);

    await processor.handleToolResponse(toolUseResponse([DECLARE_CALL]), false, 1, EVENT_PROC);

    const modelContext = (ctx as unknown as { messages: Message[] }).messages;
    const assistantIdx = modelContext.findIndex((m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === 'dd-1'));
    expect(assistantIdx).toBeGreaterThan(0);
    expect(modelContext[assistantIdx + 1].role).toBe('tool');
    expect(modelContext[assistantIdx + 1].toolResults?.[0]).toMatchObject({ toolCallId: 'dd-1', success: true });
  });

  it('declare 参数不合法：结果 success=false 并带拒绝原因，同批其他工具仍执行', async () => {
    const ctx = buildCtx();
    const deps = buildDeps(ctx);
    const bad = { id: 'dd-1', name: 'declare_deliverables', arguments: {} };
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async (): Promise<ToolResult[]> => [
        { toolCallId: 'dd-1', success: true, output: 'executor fallback', duration: 1 },
        { toolCallId: 'ws-1', success: true, output: 'search hits', duration: 5 },
      ]),
    };
    const processor = makeProcessor(ctx, deps, toolEngine);

    await processor.handleToolResponse(toolUseResponse([bad, SEARCH_CALL]), false, 1, EVENT_PROC);

    expect(toolEngine.executeToolsWithHooks).toHaveBeenCalledTimes(1);
    expect((ctx.artifact as ArtifactState).declaredDeliverables).toBeUndefined();
    const results = deps.persisted.find((m) => m.role === 'tool')?.toolResults ?? [];
    expect(results.find((r) => r.toolCallId === 'dd-1')).toMatchObject({ success: false });
    expect(results.find((r) => r.toolCallId === 'dd-1')?.error).toContain('final_artifacts');
    expect(results.find((r) => r.toolCallId === 'ws-1')?.success).toBe(true);
  });

  it('不可见工具触发 admission 重试轮时不提前记录声明（避免重复记账）', async () => {
    const ctx = buildCtx();
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn() };
    const processor = makeProcessor(ctx, deps, toolEngine);

    await processor.handleToolResponse(
      toolUseResponse([DECLARE_CALL, { id: 'ghost-1', name: 'TotallyMadeUpTool', arguments: {} }]),
      false, 1, EVENT_PROC,
    );

    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
    expect((ctx.artifact as ArtifactState).declaredDeliverables).toBeUndefined();
  });

  it('goal 闸打回 attempt_completion：调用和合成失败结果都落库，不再凭空消失', async () => {
    const goalMode = {
      isPending: () => true,
      requestCompletion: vi.fn(),
      clearCompletionRequest: vi.fn(),
      getReviewCondition: () => undefined,
      getVerifyCommand: () => undefined,
      getGoal: () => 'g',
    };
    const ctx = buildCtx({ goalMode, goalEvidenceState: { bounces: 0 } });
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn() };
    const processor = makeProcessor(ctx, deps, toolEngine);

    // 闸0 无证据可核（无 Write 记录）会把声明了产物路径的完成请求打回
    (ctx.artifact as ArtifactState).declareDeliverables({ finalArtifacts: ['/tmp/code-agent-test/never-written.md'], declaredAtMs: 1 });
    const action = await processor.handleToolResponse(toolUseResponse([COMPLETE_CALL]), false, 1, EVENT_PROC);

    expect(action).toBe('continue');
    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
    const assistant = deps.persisted.find((m) => m.role === 'assistant');
    expect(assistant?.toolCalls?.[0]?.id).toBe('ac-1');
    const tool = deps.persisted.find((m) => m.role === 'tool');
    expect(tool?.toolResults?.[0]).toMatchObject({ toolCallId: 'ac-1', success: false });
  });

  it('修复闸提前解除 early return：调用和合成失败结果都落库', async () => {
    gameValidatorState.validateGameArtifact.mockResolvedValue({
      shouldValidate: true, passed: true, failures: [], checks: ['ok'], artifactPath: '/tmp/game.html',
    });
    const ctx = buildCtx();
    (ctx.artifact as ArtifactState).setRepairGuard({ targetFile: '/tmp/game.html', attempts: 1, phase: 'static_repair' } as never);
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn() };
    const processor = makeProcessor(ctx, deps, toolEngine);

    const action = await processor.handleToolResponse(toolUseResponse([SEARCH_CALL]), false, 1, EVENT_PROC);

    expect(action).toBe('continue');
    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
    expect(deps.persisted.find((m) => m.role === 'assistant')?.toolCalls?.[0]?.id).toBe('ws-1');
    expect(deps.persisted.find((m) => m.role === 'tool')?.toolResults?.[0]).toMatchObject({ toolCallId: 'ws-1', success: false });
  });

  it('foreground denied-call guidance gives only a plain handoff and retains the required method', async () => {
    const ctx = buildCtx({ foregroundToolFace: true, allowedToolNames: ['delegate_task', 'Read'], maxToolCallRetries: 3 });
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn() };
    const processor = makeProcessor(ctx, deps, toolEngine);
    await processor.handleToolResponse(toolUseResponse([
      { id: 'denied-shell', name: 'Bash', arguments: { command: 'curl https://example.com' } },
    ]), false, 1, EVENT_PROC);

    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
    const guidance = deps.injected.join('\n');
    expect(guidance).toContain('我把这件事交给后台任务去做，完成后告诉你结果。');
    expect(guidance).toContain('requested method');
    expect(guidance).not.toMatch(/Bash|Browser|工具列表|工具面|not in this turn|unavailable|not loaded/i);
    const result = deps.persisted.find((message) => message.role === 'tool')?.toolResults?.[0];
    expect(result?.success).toBe(false);
    expect(result?.error).not.toMatch(/tool list|tool face|disabled|permission policy/i);
  });

  it('run 级禁用工具：整批调用和每条合成失败结果都落库（含批内被连带跳过的调用）', async () => {
    const ctx = buildCtx({ deniedToolNames: ['WebSearch'], maxToolCallRetries: 3 });
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn() };
    const processor = makeProcessor(ctx, deps, toolEngine);

    const action = await processor.handleToolResponse(toolUseResponse([DECLARE_CALL, SEARCH_CALL]), false, 1, EVENT_PROC);

    expect(action).toBe('continue');
    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
    const messages = (ctx as unknown as { messages: Message[] }).messages;
    const assistantIdx = messages.findIndex((m) => m.role === 'assistant' && m.toolCalls?.length === 2);
    expect(assistantIdx).toBeGreaterThan(0);
    const results = messages[assistantIdx + 1].toolResults ?? [];
    expect(messages[assistantIdx + 1].role).toBe('tool');
    expect(results.map((r) => r.toolCallId).sort()).toEqual(['dd-1', 'ws-1']);
    expect(results.every((r) => r.success === false)).toBe(true);
    expect(results.find((r) => r.toolCallId === 'ws-1')?.metadata).toMatchObject({ code: 'TOOL_DISABLED_FOR_RUN' });
    expect(results.find((r) => r.toolCallId === 'dd-1')?.metadata).toMatchObject({ code: 'TOOL_BATCH_SKIPPED' });
  });

  it.each([
    ['合法参数', DECLARE_CALL, true],
    ['非法参数', { id: 'dd-1', name: 'declare_deliverables', arguments: {} }, false],
  ])('tool_call_end 事件与落库结果一致，且不含内部兜底话术（%s）', async (_label, call, expectOk) => {
    // 事件发出即序列化（真实前端拿到的是当时的快照），避免后续就地改写让断言假绿
    const emitted: Array<{ type: string; data: { toolCallId?: string; success?: boolean; output?: string; error?: string } }> = [];
    const ctx = buildCtx({
      sessionId: 'sess-declare-event',
      onEvent: vi.fn((event: unknown) => { emitted.push(JSON.parse(JSON.stringify(event))); }),
    });
    const deps = buildDeps(ctx);
    const processor = makeProcessor(ctx, deps, makeRealEngine(ctx, deps));

    await processor.handleToolResponse(toolUseResponse([call]), false, 1, EVENT_PROC);

    const endEvent = emitted.find((e) => e.type === 'tool_call_end' && e.data.toolCallId === 'dd-1');
    const persisted = deps.persisted.find((m) => m.role === 'tool')?.toolResults?.find((r) => r.toolCallId === 'dd-1');
    expect(endEvent?.data.success).toBe(expectOk);
    expect(persisted?.success).toBe(expectOk);
    expect(endEvent?.data.output).toBe(persisted?.output);
    expect(endEvent?.data.error).toBe(persisted?.error);
    expect(JSON.stringify(endEvent?.data)).not.toContain('兜底');
    if (expectOk) expect(endEvent?.data.output).toContain('已记录最终产物声明');
    else expect(endEvent?.data.error).toContain('final_artifacts');
  });
});
