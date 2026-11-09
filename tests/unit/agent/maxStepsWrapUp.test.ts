import { describe, expect, it, vi } from 'vitest';
import { activateMaxStepsFinalResponse, buildMaxStepsPrompt, createStepWarning, ensureMaxStepsWrapUp, MAX_STEPS_REASON } from '../../../src/host/agent/runtime/maxStepsFallback';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

vi.mock('../../../src/host/services', () => ({ getBudgetService: vi.fn() }));

const bannedTerms = [
  '工具暂时停用', '工具已停用', '工具被停用', '工具停用', '最大步数', '步数上限',
  '轮次', '迭代', 'max-steps', 'Tools are disabled', 'maximum steps',
];

function expectPlain(text: string) {
  for (const term of bannedTerms) expect(text.toLowerCase(), term).not.toContain(term.toLowerCase());
}

function makeCtx(
  maxIterations = 8,
  modifiedFiles: ReturnType<RuntimeContext['nudgeManager']['getModifiedFilesSince']> = ['sample.html'],
) {
  return {
    maxIterations,
    workingDirectory: '/workspace/project',
    control: ControlState.forTest({}),
    stats: { runStartTime: 100 },
    messages: [],
    circuitBreaker: { isTripped: () => false },
    goalTracker: { getGoalSummary: () => ({ goal: '汇报演示稿', pending: ['合成八页演示稿', '检查版式'] }) },
    nudgeManager: { getModifiedFilesSince: () => modifiedFiles },
    onEvent: vi.fn(),
  } as unknown as RuntimeContext;
}

describe('plain-language run handoff', () => {
  it('injects exactly once at two remaining and resets for a new run', () => {
    const ctx = makeCtx();
    const inject = vi.fn();
    const warn = createStepWarning(ctx, inject);
    for (const iteration of [1, 2, 3, 4, 5]) warn(iteration);
    expect(inject).not.toHaveBeenCalled();
    for (const iteration of [6, 6, 7, 8]) warn(iteration);
    expect(inject).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('About 2 steps remain'), 'nudge');
    expect(inject.mock.calls[0][0]).toContain('Save and deliver existing results first');
    expect(inject.mock.calls[0][0]).toContain('Do not start new branches');
    createStepWarning(ctx, inject)(6);
    expect(inject).toHaveBeenCalledTimes(2);
  });

  it.each([1, 2, 3])('does not warn for a cap of %s', (cap) => {
    const inject = vi.fn();
    const warn = createStepWarning(makeCtx(cap), inject);
    for (let iteration = 0; iteration <= cap; iteration++) warn(iteration);
    expect(inject).not.toHaveBeenCalled();
  });

  it('does not warn when final response is already active', () => {
    const ctx = makeCtx();
    ctx.control.forceFinalResponse('resource-limit-reached', 'handoff');
    const inject = vi.fn();
    createStepWarning(ctx, inject)(6);
    expect(inject).not.toHaveBeenCalled();
  });

  it('builds a plain three-part prompt while retaining the hard no-call rule', () => {
    expectPlain(buildMaxStepsPrompt());
    expect(buildMaxStepsPrompt()).toContain('Do NOT make any tool calls');
    expect(buildMaxStepsPrompt()).toContain('workspace-relative links and friendly filenames');
    expect(buildMaxStepsPrompt()).toContain('never expose internal directories or raw commands');
    expect(buildMaxStepsPrompt()).toContain('已完成');
    expect(buildMaxStepsPrompt()).toContain('未完成');
    expect(buildMaxStepsPrompt()).toContain('回复「继续」');
    const ctx = makeCtx();
    activateMaxStepsFinalResponse(ctx);
    expect(ctx.control.forceFinalResponseReason).toBe(MAX_STEPS_REASON);
    expect(ctx.control.forceFinalResponsePrompt).toBe(buildMaxStepsPrompt());
  });

  it('builds the resource handoff with the same plain-language contract', () => {
    const ctx = makeCtx();
    activateMaxStepsFinalResponse(ctx, 'Budget exhausted');
    expect(ctx.control.forceFinalResponseReason).toBe('resource-limit-reached');
    expectPlain(ctx.control.forceFinalResponsePrompt!);
    expect(ctx.control.forceFinalResponsePrompt).toContain('Resource handoff: Budget exhausted');
    expect(ctx.control.forceFinalResponsePrompt).toContain('已完成');
    expect(ctx.control.forceFinalResponsePrompt).toContain('未完成');
    activateMaxStepsFinalResponse(ctx);
    expect(ctx.control.forceFinalResponseReason).toBe('resource-limit-reached');
  });

  it('shows friendly file paths in the deterministic fallback', async () => {
    const ctx = makeCtx(4, ['/workspace/project/samples/business.html', '/private/cache/preview.html']);
    activateMaxStepsFinalResponse(ctx);
    const persist = vi.fn();
    await ensureMaxStepsWrapUp(ctx, { generateId: () => 'fallback', addAndPersistMessage: persist }, 4);
    const text = persist.mock.calls[0][0].content;
    expect(text).toContain('samples/business.html、preview.html');
    expect(text).not.toContain('/workspace/project');
    expect(text).not.toContain('/private/cache');
    expectPlain(text);
  });

  it.each([true, false])('persists an honest plain fallback with pending items (visible output: %s)', async (hasOutput) => {
    const ctx = makeCtx(4, hasOutput ? ['sample.html'] : []);
    activateMaxStepsFinalResponse(ctx);
    const persist = vi.fn();
    await ensureMaxStepsWrapUp(ctx, { generateId: () => 'fallback', addAndPersistMessage: persist }, 4);
    const message = persist.mock.calls[0][0];
    expectPlain(message.content);
    expect(message.content).toContain('**已完成**');
    expect(message.content).toContain('**未完成**');
    expect(message.content).toContain('合成八页演示稿');
    expect(message.content).toContain('检查版式');
    expect(message.content).toContain('回复「继续」我接着做。');
    expect(message.content).toContain(hasOutput ? 'sample.html' : '没有留下可见产出');
    expect(ctx.onEvent).toHaveBeenCalledWith({ type: 'message', data: message });
  });
});
