import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnState } from '../../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../../src/host/agent/runtime/controlState';
import { RunStatsState } from '../../../../src/host/agent/runtime/runStatsState';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import { ConversationRuntime } from '../../../../src/host/agent/runtime/conversationRuntime';
import { runStartupContextAssembly } from '../../../../src/host/agent/runtime/conversationRuntimeContextBootstrap';
import { watchFirstModelRequest, noteFirstModelRequestPhase } from '../../../../src/host/agent/runtime/firstModelRequestWatch';
import { makeAiSdkFetch } from '../../../../src/host/model/adapters/aiSdkFetch';
import { ConcurrencyLimiter } from '../../../../src/host/model/concurrencyLimiter';
import { STARTUP_TIMEOUTS } from '../../../../src/shared/constants';

const boundary = vi.hoisted(() => ({
  warn: vi.fn(), info: vi.fn(),
  initialize: vi.fn(), prompt: vi.fn(),
  memory: vi.fn(), axios: vi.fn(),
}));
vi.mock('axios', () => ({ default: boundary.axios }));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ warn: boundary.warn, info: boundary.info, debug: vi.fn(), error: vi.fn() }),
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/host/services', () => ({
  getLangfuseService: () => ({ startTrace: vi.fn() }),
  getSessionManager: () => ({ getTodos: vi.fn().mockResolvedValue([]) }),
}));
vi.mock('../../../../src/host/mcp/logCollector', () => ({ logCollector: { agent: vi.fn() } }));
vi.mock('../../../../src/host/utils/seedMemoryInjector', () => ({
  buildPackedSeedMemory: boundary.memory,
  buildPackedUserDirectives: vi.fn().mockResolvedValue(null),
  buildSeedMemoryBlock: vi.fn().mockReturnValue(null),
}));
vi.mock('../../../../src/host/lightMemory/sessionMetadata', () => ({ recordSessionStart: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../../src/host/lightMemory/recentConversations', () => ({ buildRecentConversationsBlock: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../../src/host/agent/sessionRecovery', () => ({ getSessionRecoveryService: () => ({ checkPreviousSession: vi.fn().mockResolvedValue(null) }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function context(sessionId = 'weekly-report-session'): RuntimeContext {
  return {
    sessionId, messages: [], workingDirectory: '/tmp/weekly-report', onEvent: vi.fn(),
    memoryMode: 'on', modelConfig: { provider: 'test-provider', model: 'test-model' },
    systemPrompt: '', control: ControlState.forTest(),
    stats: RunStatsState.forTest(), turn: TurnState.forTest(),
    turnQualityState: {},
    hookManager: { initialize: boundary.initialize, triggerUserPromptSubmit: boundary.prompt, triggerSessionStart: vi.fn().mockResolvedValue({}) },
  } as unknown as RuntimeContext;
}

function bootstrap(ctx: RuntimeContext) {
  return runStartupContextAssembly(ctx, {
    injectSystemMessage: vi.fn(),
  } as unknown as Parameters<typeof runStartupContextAssembly>[1], {
    userMessage: 'Prepare the weekly report in the background', isSimpleTask: true,
    injectActivityContext: vi.fn().mockResolvedValue(undefined),
    bootstrapDesktopDerivedContext: vi.fn().mockResolvedValue(undefined),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  boundary.initialize.mockResolvedValue(undefined);
  boundary.prompt.mockResolvedValue({ shouldProceed: false });
  boundary.memory.mockResolvedValue(null);
  boundary.axios.mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: '{}' });
});
afterEach(() => { vi.useRealTimers(); });

function delayWarnings() {
  return boundary.warn.mock.calls.filter(([message]) => message === 'First model request delayed');
}

describe('first model request wait through production entries', () => {
  it('ConversationRuntime.run warns once after 30s in real initializeRun hook initialization', async () => {
    const hook = deferred<void>();
    boundary.initialize.mockReturnValue(hook.promise);
    const runtime = new ConversationRuntime(context());
    runtime.toolEngine = { resetRepairGate: vi.fn() } as unknown as typeof runtime.toolEngine;
    // The real run() and initializeRun() execute; only the external hook is delayed.
    const run = runtime.run('Prepare the weekly report');
    const result = run.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUTS.FIRST_MODEL_REQUEST_WARN_MS - 1);
    expect(delayWarnings()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(delayWarnings()).toEqual([['First model request delayed', expect.objectContaining({
      sessionId: 'weekly-report-session', phase: 'hook_initialization', elapsedMs: 30_000,
    })]]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(delayWarnings()).toHaveLength(1);
    const failure = new Error('hook failed');
    hook.reject(failure);
    expect(await result).toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runStartupContextAssembly distinguishes a slow user prompt hook', async () => {
    const hook = deferred<{ shouldProceed: boolean }>();
    boundary.prompt.mockReturnValue(hook.promise);
    const run = watchFirstModelRequest('hook-session', () => bootstrap(context('hook-session')));
    await vi.advanceTimersByTimeAsync(30_001);
    expect(delayWarnings()).toEqual([['First model request delayed', expect.objectContaining({ phase: 'user_prompt_hook' })]]);
    hook.resolve({ shouldProceed: false });
    expect(await run).toBe('blocked');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runStartupContextAssembly distinguishes seed memory and ignores auxiliary provider requests', async () => {
    const memory = deferred<null>();
    boundary.prompt.mockResolvedValue({ shouldProceed: true });
    const ctx = context('memory-session');
    // A preceding user message means this is not the once-per-session hook.
    ctx.messages.push({ id: 'previous', role: 'user', content: 'weekly report', timestamp: 1 });
    boundary.memory.mockImplementation(async () => {
      const limiter = new ConcurrencyLimiter('test', 1, 0);
      await limiter.acquire();
      await makeAiSdkFetch('test-provider')('https://example.invalid/v1/chat/completions');
      limiter.release();
      return memory.promise;
    });
    const run = watchFirstModelRequest('memory-session', () => bootstrap(ctx));
    await vi.advanceTimersByTimeAsync(30_001);
    expect(delayWarnings()).toEqual([['First model request delayed', expect.objectContaining({ phase: 'seed_memory' })]]);
    memory.resolve(null);
    expect(await run).toBe('proceed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ConcurrencyLimiter.acquire distinguishes provider queue and transport clears the wait', async () => {
    const limiter = new ConcurrencyLimiter('test', 1, 0);
    await limiter.acquire();
    const run = watchFirstModelRequest('queued-session', async () => {
      noteFirstModelRequestPhase('provider_dispatch');
      await limiter.acquire();
      await makeAiSdkFetch('test-provider')('https://example.invalid/v1/chat/completions');
      limiter.release();
    });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(delayWarnings()).toEqual([['First model request delayed', expect.objectContaining({ phase: 'provider_queue' })]]);
    limiter.release();
    await run;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(delayWarnings()).toHaveLength(1);
    expect(boundary.info).toHaveBeenCalledWith('First model request dispatched', expect.objectContaining({ provider: 'test-provider' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('makeAiSdkFetch stops the wait at dispatch, without waiting for the provider response', async () => {
    const response = deferred<{ status: number; statusText: string; headers: object; data: string }>();
    boundary.axios.mockReturnValue(response.promise);
    const run = watchFirstModelRequest('response-session', async () => {
      noteFirstModelRequestPhase('provider_dispatch');
      await makeAiSdkFetch('test-provider')('https://example.invalid/v1/chat/completions');
    });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(delayWarnings()).toHaveLength(0);
    response.resolve({ status: 200, statusText: 'OK', headers: {}, data: '{}' });
    await run;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the acceptance deadline across phases and isolates simultaneous sessions', async () => {
    const first = deferred<{ shouldProceed: boolean }>();
    const second = deferred<{ shouldProceed: boolean }>();
    boundary.prompt.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const runA = watchFirstModelRequest('session-a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return bootstrap(context('session-a'));
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const runB = watchFirstModelRequest('session-b', () => bootstrap(context('session-b')));
    await vi.advanceTimersByTimeAsync(10_001);
    expect(delayWarnings()).toEqual([['First model request delayed', expect.objectContaining({
      sessionId: 'session-a', phase: 'user_prompt_hook', elapsedMs: 30_000, phaseElapsedMs: 10_000,
    })]]);
    first.resolve({ shouldProceed: false });
    second.resolve({ shouldProceed: false });
    await Promise.all([runA, runB]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(delayWarnings()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runStartupContextAssembly cancellation cleans up without a late warning', async () => {
    boundary.prompt.mockReturnValue(new Promise(() => {}));
    const ctx = context();
    ctx.control.setRunAbortController(new AbortController());
    const run = watchFirstModelRequest(ctx.sessionId, () => bootstrap(ctx));
    await vi.advanceTimersByTimeAsync(5_000);
    ctx.control.markCancelled();
    ctx.control.abortRun();
    expect(await run).toBe('aborted');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(delayWarnings()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
