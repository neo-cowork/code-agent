import { ToolExecutionEngine } from '../../../../src/host/agent/runtime/toolExecutionEngine';
import { AntiPatternDetector } from '../../../../src/host/agent/antiPattern/detector';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';
function makeRuntimeContext(execute: RuntimeContext['toolExecutor']['execute']): RuntimeContext {
  return {
    systemPrompt: '',
    modelConfig: { provider: 'openai', model: 'gpt-test' } as never,
    toolExecutor: { execute } as never,
    messages: [],
    onEvent: (() => {}),
    modelRouter: {} as never,
    maxIterations: 10,
    workingDirectory: '/tmp/env-resume-test',
    isDefaultWorkingDirectory: false,
    sessionId: 'env-assist-session',
    runId: 'env-assist-run',
    persistLongTermMemory: true,
    includeRecentConversations: true,
    circuitBreaker: {
      recordFailure: (() => false),
      recordSuccess: (() => {}),
      generateWarningMessage: (() => {}),
      generateUserErrorMessage: (() => {}),
    } as never,
    antiPatternDetector: new AntiPatternDetector(),
    goalTracker: { recordAction: (() => {}) } as never,
    nudgeManager: {
      trackModifiedFile: (() => {}),
      checkProgressState: (() => {}),
      checkPostForceExecute: (() => {}),
    } as never,
    hookMessageBuffer: {} as never,
    messageHistoryCompressor: {} as never,
    autoCompressor: {} as never,
    compressionPipeline: {} as never,
    telemetryAdapter: {
      onTurnStart: (() => {}),
      onModelCall: (() => {}),
      onToolCallStart: (() => {}),
      onToolCallEnd: (() => {}),
      onTurnEnd: (() => {}),
    },
    turnTrace: {
      setTurn: (() => {}),
      record: (() => {}),
      flush: (() => {}),
      getEvents: (() => []),
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
}

export function makeEngine(execute: RuntimeContext['toolExecutor']['execute']) {
  const ctx = makeRuntimeContext(execute);
  const engine = new ToolExecutionEngine(ctx);
  engine.setModules(
    {
      injectSystemMessage: (() => {}),
      pushPersistentSystemContext: (() => {}),
      getCurrentAttachments: (() => []),
    } as never,
    { emitTaskProgress: (() => {}) } as never,
    { setPlanMode: (() => {}), isPlanMode: (() => false), generateAutoContinuationPrompt: (() => {}) } as never,
  );
  return { ctx, engine };
}

