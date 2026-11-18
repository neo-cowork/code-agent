// ============================================================================
// 模型输出的路径键 / command 首尾空白（N-FIX-CLEANXML-NO-TRIM-PARAM-PATH-AUDIT-REDESIGN）
// 走真实 ToolExecutionEngine.executeSingleTool：执行器收到的是裁过的路径和命令，
// 正文字段（content / old_string / new_string）保持逐字节。
// ============================================================================
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setProtocolToolRegistryPort } from '../../../src/host/tools/protocolToolRegistration';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { canonicalizeCommand } from '../../../src/host/security/canonicalizeCommand';
import { classifyCommand } from '../../../src/host/security/commandSafety';
import { resolveToolPath } from '../../../src/host/tools/writeTargets';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

const serviceMocks = vi.hoisted(() => ({
  langfuse: {
    startNestedSpan: vi.fn(),
    endSpan: vi.fn(),
  },
  injected: [] as string[],
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: vi.fn(),
  getAuthService: vi.fn(),
  getBudgetService: vi.fn(),
  getSessionManager: vi.fn(),
  getLangfuseService: () => serviceMocks.langfuse,
  BudgetAlertLevel: {},
}));

vi.mock('../../../src/host/services/citation/citationService', () => ({
  getCitationService: () => ({
    extractAndStore: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../../../src/host/services/git/fileWatcherService', () => ({
  getFileWatcherService: () => ({
    getRecentExternalChanges: vi.fn().mockReturnValue([]),
    markAsAgentModified: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services/git/gitStatusService', () => ({
  getGitStatusService: () => ({
    onPostToolUse: vi.fn(),
  }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getToolAnnotationsMap: () => new Map(),
    getToolDefinitions: () => [],
  }),
}));

function makeRuntimeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const onEvent = vi.fn();
  const telemetryAdapter = {
    onTurnStart: vi.fn(),
    onModelCall: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallEnd: vi.fn(),
    onTurnEnd: vi.fn(),
  };

  return {
    systemPrompt: '',
    modelConfig: { provider: 'openai', model: 'gpt-test' } as never,
    toolExecutor: { execute: vi.fn() } as never,
    messages: [],
    onEvent,
    modelRouter: {} as never,
    maxIterations: 10,
    workingDirectory: '/tmp/code-agent-test',
    isDefaultWorkingDirectory: false,
    sessionId: 'session-awaiting-freeze',
    persistLongTermMemory: true,
    includeRecentConversations: true,
    circuitBreaker: {
      recordFailure: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      generateWarningMessage: vi.fn(),
      generateUserErrorMessage: vi.fn(),
    } as never,
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
    } as never,
    goalTracker: { recordAction: vi.fn() } as never,
    nudgeManager: {
      trackModifiedFile: vi.fn(),
      checkProgressState: vi.fn(),
      checkPostForceExecute: vi.fn(),
    } as never,
    hookMessageBuffer: {} as never,
    messageHistoryCompressor: {} as never,
    autoCompressor: {} as never,
    compressionPipeline: {} as never,
    telemetryAdapter,
    turnTrace: {
      setTurn: vi.fn(),
      record: vi.fn(),
      flush: vi.fn(),
      getEvents: vi.fn().mockReturnValue([]),
    } as never,
    turn: TurnState.forTest({
      currentIterationSpanId: 'iteration-1',
      currentTurnId: 'turn-1',
      turnStartTime: Date.now(),
      effortLevel: 'medium' as never,
    }),
    autoApprovePlan: false,
    enableHooks: true,
    maxStopHookRetries: 0,
    maxToolCallRetries: 0,
    enableToolDeferredLoading: false,
    maxMode: false,
    maxModeCandidates: 1,
    maxStructuredOutputRetries: 0,
    stepByStepMode: false,
    turnQualityState: {},
    goalEvidenceState: { bounces: 0 },
    control: ControlState.forTest({} as never),
    budgetScope: 'foreground',
    consecutiveErrors: 0,
    stats: RunStatsState.forTest({ traceId: 'trace-1', totalInputTokens: 0, totalOutputTokens: 0, runStartTime: Date.now(), totalTokensUsed: 0, totalToolCallCount: 0 } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    MAX_CONSECUTIVE_COMPACTS: 3,
    contextHealth: ContextHealthState.forTest({ persistentSystemContext: [] } as never),
    artifact: ArtifactState.forTest(),
    enableDeliveryCritic: false,
    ...overrides,
  };
}

describe('ToolExecutionEngine 标识类参数规范化', () => {
  beforeAll(() => {
    const schemas: Array<Record<string, unknown>> = [
      { name: 'Bash', description: 't', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, permissionLevel: 'execute' },
      { name: 'Write', description: 't', inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] }, permissionLevel: 'write' },
      { name: 'Edit', description: 't', inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] }, permissionLevel: 'write' },
      { name: 'Read', description: 't', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }, permissionLevel: 'read' },
    ];
    setProtocolToolRegistryPort({
      register: () => {}, unregister: () => false,
      has: (n: string) => schemas.some((s) => s.name === n),
      getSchemas: () => schemas as never,
      resolve: async () => { throw new Error('unused'); },
    } as never);
  });

  afterAll(() => {
    setProtocolToolRegistryPort({
      register: () => {}, unregister: () => false, has: () => false,
      getSchemas: () => [], resolve: async () => { throw new Error('reset'); },
    } as never);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fileReadTracker.clear();
  });

  function makeEngine() {
    const execute = vi.fn(async (): Promise<ToolResult> => ({
      toolCallId: '', success: true, output: 'ok', metadata: { executionStarted: true },
    }));
    const ctx = makeRuntimeContext({ toolExecutor: { execute } as never });
    const engine = new ToolExecutionEngine(ctx);
    engine.setModules(
      { injectSystemMessage: vi.fn(), pushPersistentSystemContext: vi.fn(), getCurrentAttachments: vi.fn().mockReturnValue([]) } as never,
      { emitTaskProgress: vi.fn() } as never,
      { setPlanMode: vi.fn(), isPlanMode: vi.fn().mockReturnValue(false) } as never,
    );
    return { ctx, engine, execute };
  }

  it('Read 的 file_path 与 Bash 的 command 到达执行器时已裁首尾空白', async () => {
    const { engine, execute } = makeEngine();
    await engine.executeSingleTool({ id: 'r1', name: 'Read', arguments: { file_path: '\n/tmp/a.txt ' } } as ToolCall, 0, 1);
    await engine.executeSingleTool({ id: 'b1', name: 'Bash', arguments: { command: '  ls\n' } } as ToolCall, 0, 1);
    expect(execute.mock.calls[0][0]).toBe('Read');
    expect(execute.mock.calls[0][1]).toEqual({ file_path: '/tmp/a.txt' });
    expect(execute.mock.calls[1][0]).toBe('Bash');
    expect(execute.mock.calls[1][1]).toEqual({ command: 'ls' });
  });

  it('审批规则匹配 / 命令安全分类 / 路径解析：带空白与干净值结果一致', async () => {
    const { engine, execute } = makeEngine();
    await engine.executeSingleTool({ id: 'b0', name: 'Bash', arguments: { command: '  ls\n' } } as ToolCall, 0, 1);
    await engine.executeSingleTool({ id: 'r0', name: 'Read', arguments: { file_path: '\n/tmp/a.txt ' } } as ToolCall, 0, 1);
    const command = (execute.mock.calls[0][1] as { command: string }).command;
    const filePath = (execute.mock.calls[1][1] as { file_path: string }).file_path;
    expect(canonicalizeCommand(command)).toEqual(canonicalizeCommand('ls'));
    expect(classifyCommand(command)).toBe(classifyCommand('ls'));
    expect(resolveToolPath(filePath, '/tmp')).toBe(resolveToolPath('/tmp/a.txt', '/tmp'));
  });

  it('引擎侧的 toolCall.arguments 同步被裁（重读/只读命令追踪看到同一个值）', async () => {
    const { ctx, engine } = makeEngine();
    const call = { id: 'b2', name: 'Bash', arguments: { command: '  ls\n' } } as ToolCall;
    await engine.executeSingleTool(call, 0, 1);
    expect(call.arguments).toEqual({ command: 'ls' });
    expect(ctx.antiPatternDetector.trackReadOnlyShellCommand).toHaveBeenCalledWith('ls');
  });

  it('带空白与干净值的调用，执行器收到的参数完全一致', async () => {
    const { engine, execute } = makeEngine();
    await engine.executeSingleTool({ id: 'p', name: 'Write', arguments: { file_path: '\n/tmp/a.txt ', content: 'x' } } as ToolCall, 0, 1);
    await engine.executeSingleTool({ id: 'c', name: 'Write', arguments: { file_path: '/tmp/a.txt', content: 'x' } } as ToolCall, 0, 1);
    expect(execute.mock.calls[0][1]).toEqual(execute.mock.calls[1][1]);
  });

  it('Write content、Edit old_string/new_string 的首尾空白逐字节保留', async () => {
    const { engine, execute } = makeEngine();
    await engine.executeSingleTool({ id: 'w', name: 'Write', arguments: { file_path: ' /tmp/a.txt\n', content: '\n  body line\n\n' } } as ToolCall, 0, 1);
    await engine.executeSingleTool({ id: 'e', name: 'Edit', arguments: { file_path: '/tmp/a.txt', old_string: '  old\n', new_string: '\tnew \n' } } as ToolCall, 0, 1);
    expect(execute.mock.calls[0][1]).toEqual({ file_path: '/tmp/a.txt', content: '\n  body line\n\n' });
    expect(execute.mock.calls[1][1]).toEqual({ file_path: '/tmp/a.txt', old_string: '  old\n', new_string: '\tnew \n' });
  });
});
