import { describe, expect, it, vi } from 'vitest';
import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { resolveToolWriteTargets } from '../../../src/host/tools/writeTargets';
import { writeModule } from '../../../src/host/tools/modules/file/write';
import { setProtocolToolRegistryPort } from '../../../src/host/tools/protocolToolRegistration';
import { type ToolCall } from '../../../src/shared/contract';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

vi.mock('../../../src/host/services', () => ({
  getConfigService: vi.fn(),
  getAuthService: vi.fn(),
  getBudgetService: vi.fn(),
  getSessionManager: vi.fn(),
  getLangfuseService: () => ({ startNestedSpan: vi.fn(), endSpan: vi.fn() }),
  BudgetAlertLevel: {},
}));

vi.mock('../../../src/host/services/citation/citationService', () => ({
  getCitationService: () => ({ extractAndStore: vi.fn().mockReturnValue([]) }),
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

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getToolAnnotationsMap: () => new Map(),
    getToolDefinitions: () => [],
  }),
}));

describe('ToolExecutionEngine padded identifier arguments', () => {
  it('hands the executor and the write-target side the same trimmed path, and keeps content byte-exact', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true, output: 'ok' });
    setProtocolToolRegistryPort({
      register: vi.fn(),
      unregister: vi.fn().mockReturnValue(false),
      has: (name: string) => name === 'Write',
      getSchemas: () => [writeModule.schema],
      resolve: async () => writeModule.createHandler(),
    });
    const injectSystemMessage = vi.fn();
    const ctx: RuntimeContext = {
      systemPrompt: '',
      modelConfig: { provider: 'openai', model: 'gpt-test' } as never,
      toolExecutor: { execute } as never,
      messages: [],
      onEvent: vi.fn(),
      modelRouter: {} as never,
      maxIterations: 10,
      workingDirectory: '/tmp/code-agent-test',
      isDefaultWorkingDirectory: false,
      sessionId: 'session-padded-args',
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
      telemetryAdapter: {
        onTurnStart: vi.fn(),
        onModelCall: vi.fn(),
        onToolCallStart: vi.fn(),
        onToolCallEnd: vi.fn(),
        onTurnEnd: vi.fn(),
      },
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
      control: ControlState.forTest(),
      budgetScope: 'foreground',
      consecutiveErrors: 0,
      stats: RunStatsState.forTest({
        traceId: 'trace-1',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        runStartTime: Date.now(),
        totalTokensUsed: 0,
        totalToolCallCount: 0,
      } as never),
      MAX_CONSECUTIVE_TRUNCATIONS: 3,
      MAX_CONSECUTIVE_COMPACTS: 3,
      contextHealth: ContextHealthState.forTest({ persistentSystemContext: [] } as never),
      artifact: ArtifactState.forTest(),
      enableDeliveryCritic: false,
    };
    const engine = new ToolExecutionEngine(ctx);
    engine.setModules(
      {
        injectSystemMessage,
        pushPersistentSystemContext: vi.fn(),
        getCurrentAttachments: vi.fn().mockReturnValue([]),
      } as never,
      { emitTaskProgress: vi.fn() } as never,
      { setPlanMode: vi.fn(), isPlanMode: vi.fn().mockReturnValue(false), generateAutoContinuationPrompt: vi.fn() } as never,
    );

    const content = '\n  body line\n\n';
    await engine.executeToolsWithHooks([
      { id: 'call-write-padded', name: 'Write', arguments: { file_path: '\n/Users/x/.ssh/config ', content, command: '  ls\n' } } as ToolCall,
    ]);

    expect(execute).toHaveBeenCalled();
    const params = execute.mock.calls[0][1] as Record<string, unknown>;
    expect(params.file_path).toBe('/Users/x/.ssh/config');
    expect(params.content).toBe(content);
    expect(params.command).toBe('ls');
    const definition = writeModule.schema as never;
    const seen = resolveToolWriteTargets({ definition, params, workingDirectory: '/tmp/code-agent-test' });
    const tidy = resolveToolWriteTargets({
      definition, params: { ...params, file_path: '/Users/x/.ssh/config' }, workingDirectory: '/tmp/code-agent-test',
    });
    expect(seen.targets).toEqual(tidy.targets);
    expect(seen.targets.some((t) => t.includes('.ssh/config') && !t.includes('/tmp/code-agent-test'))).toBe(true);
  });
});
