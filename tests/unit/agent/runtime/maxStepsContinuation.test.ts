import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/shared/contract';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import { RUN_ERROR_CODE_MAX_ITERATIONS } from '../../../../src/shared/constants';

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false, getTodos: () => [] }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/host/agent/runtime/runtimeStatePersistence', () => ({
  loadPersistedRuntimeState: () => null, persistRuntimeState: vi.fn(),
}));
vi.mock('../../../../src/host/agent/runtime/turnCostPersistence', () => ({
  createTurnCostEventHandler: ({ onEvent }: { onEvent: unknown }) => onEvent,
}));
vi.mock('../../../../src/host/telemetry/telemetryAdapter', () => ({ createTelemetryAdapter: () => undefined }));
vi.mock('../../../../src/host/services/skills/comboRecorder', () => ({
  getComboRecorder: () => ({ startRecording: vi.fn(), markTurn: vi.fn() }),
}));
vi.mock('../../../../src/host/context/autoCompressor', () => ({ getAutoCompressor: () => ({}) }));
vi.mock('../../../../src/host/services', () => ({
  getBudgetService: () => ({ checkBudget: () => ({ exceeded: false, usagePercentage: 0 }) }),
  getSessionManager: () => ({ getTodos: () => [] }),
}));
vi.mock('../../../../src/host/context/contextEventLedger', () => ({
  getContextEventLedger: () => ({ append: vi.fn(), upsertEvents: vi.fn() }),
}));
vi.mock('../../../../src/host/agent/runtime/jevWarden', () => ({ createJevWarden: () => ({ interceptFinal: vi.fn(), reviewToolStep: vi.fn() }) }));
vi.mock('../../../../src/host/agent/persistentRoleResolution', () => ({ resolvePersistentRoleId: async () => undefined }));
vi.mock('../../../../src/host/agent/capabilityGapTurnRecorder', () => ({ recordCapabilityGapTurn: vi.fn() }));
vi.mock('../../../../src/host/agent/runtime/workDirectoryMaterializer', () => ({
  beginWorkDirectoryRun: vi.fn(), endWorkDirectoryRun: vi.fn(),
}));
vi.mock('../../../../src/host/observability/posthogNode', () => ({ trackNode: vi.fn() }));
vi.mock('../../../../src/host/agent/runtime/turnOutcomeStamp', () => ({ recordTurnOutcomeStamp: vi.fn() }));
vi.mock('../../../../src/host/services/roleAssets/roleProactivity', () => ({ triggerEventWakes: vi.fn() }));
vi.mock('../../../../src/host/services/planning/taskStore', () => ({ getIncompleteTasks: () => [] }));
vi.mock('../../../../src/host/services/core/promptSuggestions', () => ({ generateContextSuggestions: async () => [] }));

import { AgentLoop } from '../../../../src/host/agent/agentLoop';
import { withSessionCommandCenterBrain } from '../../../../src/host/app/sessionCommandCenterBrain';
import { ConversationRuntime } from '../../../../src/host/agent/runtime/conversationRuntime';
import { ContextAssembly } from '../../../../src/host/agent/runtime/contextAssembly';
import { RunFinalizer } from '../../../../src/host/agent/runtime/runFinalizer';
import { StreamHandler } from '../../../../src/host/agent/runtime/streamHandler';
import { MessageProcessor } from '../../../../src/host/agent/runtime/messageProcessor';
import { ensureMaxStepsWrapUp, activateMaxStepsFinalResponse, buildMaxStepsErrorData, createStepWarning } from '../../../../src/host/agent/runtime/maxStepsFallback';
import { getBackgroundSubagentRegistry } from '../../../../src/host/agent/backgroundSubagentRegistry';

// Real foreground options -> AgentLoop composition root -> real runtime and persistence.
// Only startup integrations, provider responses and post-run integrations are isolated.
function foreground(maxIterations = 8, foregroundToolFace = true, prompt = 'read the handoff notes', runId?: string) {
  const persisted: Message[] = [];
  const loop = new AgentLoop({
    ...withSessionCommandCenterBrain({ maxIterations }, prompt),
    foregroundToolFace,
    modelConfig: { provider: 'openai', model: 'test-model', apiKey: 'test' },
    toolExecutor: {} as never,
    messages: [], onEvent: vi.fn(), sessionId: 'step-limit-session', runId,
    workingDirectory: '/tmp', memoryMode: 'off', enableHooks: false, persistLongTermMemory: false,
    persistMessage: async (message) => { persisted.push(structuredClone(message)); },
  });
  const ctx = (loop as unknown as { ctx: RuntimeContext }).ctx;
  const assembly = new ContextAssembly(ctx);
  vi.spyOn(assembly, 'updateContextHealth').mockImplementation(() => undefined);
  vi.spyOn(assembly, 'checkAndAutoCompress').mockResolvedValue(undefined as never);
  const finalizer = {
    emitTaskProgress: vi.fn(), emitTaskComplete: vi.fn(), tryParseTodosFromResponse: vi.fn(),
  } as unknown as RunFinalizer;
  return { loop, ctx, assembly, persisted, finalizer };
}

afterEach(() => vi.restoreAllMocks());

describe('foreground step-limit continuation', () => {
  it('emits a failure instead of a pause when this run still owns a background child', async () => {
    const { ctx, assembly } = foreground(8, true, 'read the handoff notes', 'parent-run');
    ctx.stats.beginRun();
    await assembly.addAndPersistMessage({ id: 'handoff', role: 'assistant', content: 'Work remains.', timestamp: Date.now(), metadata: { stoppedByStepLimit: true } });
    vi.spyOn(getBackgroundSubagentRegistry(), 'list').mockReturnValue([
      { runId: 'parent-run', sessionId: ctx.sessionId, status: 'running' },
    ] as ReturnType<ReturnType<typeof getBackgroundSubagentRegistry>['list']>);
    const finalizer = new RunFinalizer(ctx);
    finalizer.setModules(assembly, { runSessionEndLearning: vi.fn() } as never);

    await finalizer.finalizeRun(8, 'Prepare a report', { endTrace: vi.fn(), flush: vi.fn(async () => undefined) } as never, 8);

    const error = vi.mocked(ctx.onEvent).mock.calls.map(([event]) => event).find((event) => event.type === 'error');
    expect(error?.data).toEqual({ message: 'Max iterations reached', code: RUN_ERROR_CODE_MAX_ITERATIONS });
    expect(buildMaxStepsErrorData({ ...ctx, runId: 'other-run' })).toEqual({ message: 'Max iterations reached', code: RUN_ERROR_CODE_MAX_ITERATIONS, details: { stoppedByStepLimit: true } });
  });
  it('warns at the larger foreground deliverable cap minus two, not at six', () => {
    const { ctx } = foreground(50, true, '制作 PPTX');
    expect(ctx.maxIterations).toBe(30);
    const inject = vi.fn();
    const warn = createStepWarning(ctx, inject);
    for (let iteration = 1; iteration < 28; iteration++) warn(iteration);
    expect(inject).not.toHaveBeenCalled();
    warn(28);
    expect(inject).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('About 2 steps remain'), 'nudge');
    warn(28);
    warn(29);
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['foreground forced final', true, true, false, true],
    ['foreground fallback', true, false, false, true],
    ['background/no-marker stop keeps its failure state', false, true, false, false],
    ['foreground without a marked final', true, false, true, false],
    ['historical marker is not the current run summary', true, true, true, false],
  ] as const)('real runFinalizer emits the pause flag only for %s', async (_name, foregroundToolFace, forced, noNewSummary, marked) => {
    const { ctx, assembly, persisted, finalizer: processorFinalizer } = foreground(8, foregroundToolFace);
    ctx.stats.beginRun();
    if (noNewSummary) {
      await assembly.addAndPersistMessage({ id: 'old-summary', role: 'assistant', content: 'Old progress.',
        timestamp: ctx.stats.runStartTime - 1, ...(forced ? { metadata: { stoppedByStepLimit: true } } : {}),
      });
    } else if (forced) {
      activateMaxStepsFinalResponse(ctx);
      await new MessageProcessor(ctx, assembly, processorFinalizer, {} as never).handleTextResponse(
        { type: 'text', content: 'Saved progress; more notes remain.', finishReason: 'stop' },
        true, 8, false, { endSpan: vi.fn() },
      );
    } else {
      activateMaxStepsFinalResponse(ctx);
      await ensureMaxStepsWrapUp(ctx, assembly, 8);
    }
    const finalizer = new RunFinalizer(ctx);
    finalizer.setModules(assembly, { runSessionEndLearning: vi.fn() } as never);
    await finalizer.finalizeRun(8, 'Read the notes and write a weekly report', {
      endTrace: vi.fn(), flush: vi.fn(async () => undefined),
    } as never, 8);
    const events = vi.mocked(ctx.onEvent).mock.calls.map(([event]) => event);
    const error = events.find((event) => event.type === 'error');
    expect(error).toMatchObject({ type: 'error', data: { message: 'Max iterations reached', code: RUN_ERROR_CODE_MAX_ITERATIONS } });
    expect(error?.data).toEqual({ message: 'Max iterations reached', code: RUN_ERROR_CODE_MAX_ITERATIONS,
      ...(marked ? { details: { stoppedByStepLimit: true } } : {}),
    });
    expect(persisted.at(-1)?.metadata?.stoppedByStepLimit).toBe((marked || (noNewSummary && forced)) ? true : undefined);
  });

  it.each([
    ['forced final', 8, true, true],
    ['normal final', 8, false, false],
    ['single iteration', 1, true, false],
    ['background final', 8, true, false],
  ] as const)('%s persists the correct marker through MessageProcessor and ContextAssembly', async (name, limit, forced, marked) => {
    const { ctx, assembly, persisted, finalizer } = foreground(limit, name !== 'background final');
    if (forced) ctx.control.forceFinalResponse('max-steps-reached', 'summary');
    const processor = new MessageProcessor(ctx, assembly, finalizer, {} as never);
    await processor.handleTextResponse({ type: 'text', content: 'Partial work is saved. More notes remain.', finishReason: 'stop' }, true, limit, false, { endSpan: vi.fn() });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].metadata?.stoppedByStepLimit).toBe(marked ? true : undefined);
    expect(persisted[0].content).toBe('Partial work is saved. More notes remain.');
    if (forced) expect(ctx.control.forceFinalResponseReason).toBeUndefined();
  });

  it('ensureMaxStepsWrapUp persists a marked synthesized final through real ContextAssembly', async () => {
    const { ctx, assembly, persisted } = foreground();
    activateMaxStepsFinalResponse(ctx);
    await ensureMaxStepsWrapUp(ctx, assembly, 8);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].metadata?.stoppedByStepLimit).toBe(true);
  });

  it.each([1, 8])('synthesis does not mark a normal finish or maxIterations=1 (%s)', async (limit) => {
    const { ctx, assembly, persisted } = foreground(limit);
    if (limit === 1) activateMaxStepsFinalResponse(ctx);
    await ensureMaxStepsWrapUp(ctx, assembly, limit);
    expect(persisted).toEqual([]);
  });

  it('a follow-up starts from iteration 0 through foreground options -> AgentLoop -> real runtime loop', async () => {
    let { loop, ctx } = foreground();
    const turns: number[] = [];
    const langfuse = { endSpan: vi.fn(), startSpan: vi.fn(), logEvent: vi.fn() };
    vi.spyOn(ConversationRuntime.prototype, 'initializeRun').mockImplementation(async () => {
      ctx.turn.beginRun('read the handoff notes');
      return { langfuse, isSimpleTask: true, genNum: 8 } as never;
    });
    vi.spyOn(StreamHandler.prototype, 'setupIteration').mockImplementation((iteration) => { turns.push(iteration); return undefined as never; });
    vi.spyOn(StreamHandler.prototype, 'injectPlanContext').mockResolvedValue(undefined);
    vi.spyOn(StreamHandler.prototype, 'injectContextualMemory').mockResolvedValue(undefined);
    vi.spyOn(StreamHandler.prototype, 'emitModelResponse').mockImplementation(() => undefined);
    vi.spyOn(ContextAssembly.prototype, 'inference').mockImplementation(async () => {
      if (!ctx.control.forceFinalResponseReason && turns.length < 8) ctx.turn.requestReinference();
      return { type: 'text', content: 'Saved the summary.', finishReason: 'stop' };
    });
    vi.spyOn(ContextAssembly.prototype, 'updateContextHealth').mockImplementation(() => undefined);
    vi.spyOn(ContextAssembly.prototype, 'checkAndAutoCompress').mockResolvedValue(undefined as never);
    vi.spyOn(RunFinalizer.prototype, 'checkAndEmitBudgetStatus').mockReturnValue(false);
    vi.spyOn(RunFinalizer.prototype, 'finalizeRun').mockResolvedValue(undefined);
    vi.spyOn(RunFinalizer.prototype, 'emitTaskProgress').mockImplementation(() => undefined);
    vi.spyOn(RunFinalizer.prototype, 'emitTaskComplete').mockImplementation(() => undefined);
    vi.spyOn(RunFinalizer.prototype, 'tryParseTodosFromResponse').mockImplementation(() => undefined);
    await loop.run('read the handoff notes');
    expect(turns).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ctx.messages.at(-1)?.metadata?.stoppedByStepLimit).toBe(true);
    const continued = foreground();
    continued.ctx.messages.push(...ctx.messages);
    loop = continued.loop;
    ctx = continued.ctx;
    expect(ctx.foregroundToolFace).toBe(true);
    expect(ctx.maxIterations).toBe(8);
    expect(ctx.turnTrace.turnIndex).toBe(0);
    turns.length = 0;
    vi.mocked(ContextAssembly.prototype.inference).mockResolvedValue({ type: 'text', content: 'Continued the work.', finishReason: 'stop' });
    await loop.run('Continue');
    // setupIteration receives iterations after the production loop increments it.
    // First entry 1 proves its initial value was 0 rather than the previous 8.
    expect(turns).toEqual([1]);
    expect(ctx.messages.at(-1)?.metadata?.stoppedByStepLimit).toBeUndefined();
  });
});
