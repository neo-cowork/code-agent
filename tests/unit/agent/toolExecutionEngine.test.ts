import { describe, expect, it, vi } from 'vitest';
import { detectStructuredToolFailure } from '../../../src/host/agent/runtime/toolResultNormalization';
import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { validateToolArgs } from '../../../src/host/agent/runtime/toolArgsValidator';
import { writeModule } from '../../../src/host/tools/modules/file/write';
import { setProtocolToolRegistryPort } from '../../../src/host/tools/protocolToolRegistration';
import { HostReasonCode, type ToolCall } from '../../../src/shared/contract';
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

describe('detectStructuredToolFailure', () => {
  it('detects explicit error payloads returned inside successful tool output', () => {
    const output = JSON.stringify({
      status: 'error',
      tool: 'web_search',
      error: 'Brave Search API error (429)',
    });

    expect(detectStructuredToolFailure(output)).toBe('Brave Search API error (429)');
  });

  it('ignores authorization handshakes that require user action', () => {
    const output = JSON.stringify({
      success: true,
      awaiting_authorization: true,
      message: 'Please authorize and retry.',
    });

    expect(detectStructuredToolFailure(output)).toBeNull();
  });

  it('ignores normal successful JSON payloads', () => {
    const output = JSON.stringify({
      success: true,
      messageId: 'om_123',
      chatId: 'oc_456',
    });

    expect(detectStructuredToolFailure(output)).toBeNull();
  });
});

describe('ToolExecutionEngine args validation failure hostReason', () => {
  it('attaches TOOL_ARGS_INVALID hostReason with toolName while keeping model-facing error byte-identical', async () => {
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
      toolExecutor: { execute: vi.fn() } as never,
      messages: [],
      onEvent: vi.fn(),
      modelRouter: {} as never,
      maxIterations: 10,
      workingDirectory: '/tmp/code-agent-test',
      isDefaultWorkingDirectory: false,
      sessionId: 'session-args-invalid',
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

    const expectedValidation = validateToolArgs('Write', writeModule.schema.inputSchema, {});
    expect(expectedValidation.ok).toBe(false);
    if (expectedValidation.ok) return;

    const [result] = await engine.executeToolsWithHooks([
      { id: 'call-write-invalid', name: 'Write', arguments: {} } as ToolCall,
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toBe(expectedValidation.message);
    expect(result.error).toContain('<tool-args-validation-error>');
    expect(result.error).toContain('完整参数 schema');
    expect(result.error).toContain('Minimal valid call:');
    expect(injectSystemMessage).toHaveBeenCalledWith(expectedValidation.message, 'tool-schema-repair');
    expect(result.metadata?.hostReason).toEqual({
      code: HostReasonCode.ToolArgsInvalid,
      metadata: { toolName: 'Write' },
      modelText: expectedValidation.message,
    });
  });
});
