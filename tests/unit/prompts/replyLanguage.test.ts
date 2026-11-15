import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services', () => ({ getBudgetService: vi.fn() }));

// 改动前在 zh 下抓取的 sha256（日期固定为 2026-11-14，vitest 临时目录名归一化）：zh 提示词字节必须不变
const ZH_GOLDEN = {
  buildPrompt: '03206f1bb89a3db0d611ac4110efb851f14b896efdc6f7cc07a5f9b856bb58b2',
  profile: '31b27e9f3f93622f37d640c54d4add04fad1e1e2a10ea9da9ba9d25ca33999e0',
  maxSteps: '5305d6e2dd6cb2d16083978f08b9e93a9e4dc103a5413bfcba36a2e4adf8c327',
};
const sha = (s: string) => createHash('sha256')
  .update(s.replace(/code-agent-vitest-run-[A-Za-z0-9]+/g, 'code-agent-vitest-run-X'))
  .digest('hex');
const DIRECTIVE = 'Reply in English by default';

async function load(language: 'zh' | 'en') {
  vi.resetModules();
  vi.doMock('../../../src/host/services/core/configService', () => ({
    getConfigService: () => ({ getSettings: () => ({ ui: { language } }) }),
  }));
  const builder = await import('../../../src/host/prompts/builder');
  const maxSteps = await import('../../../src/host/agent/runtime/maxStepsFallback');
  return { ...builder, ...maxSteps };
}

describe('reply language follows ui.language', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../../../src/host/services/core/configService');
  });

  it('en: buildPrompt stable prefix carries the directive before the dynamic boundary', async () => {
    const { buildPrompt } = await load('en');
    const prompt = buildPrompt();
    expect(prompt).toContain(DIRECTIVE);
    expect(prompt).toContain('If the user explicitly asks for another language, follow the user');
  });

  it('en: buildProfilePrompt interactive and subagent carry the directive', async () => {
    const { buildProfilePrompt } = await load('en');
    expect(buildProfilePrompt('interactive')).toContain(DIRECTIVE);
    expect(buildProfilePrompt('subagent')).toContain(DIRECTIVE);
  });

  it('zh: prompts are byte-identical to the pre-change output', async () => {
    const { buildPrompt, buildProfilePrompt, buildMaxStepsPrompt } = await load('zh');
    expect(sha(buildPrompt())).toBe(ZH_GOLDEN.buildPrompt);
    expect(sha(buildProfilePrompt('interactive'))).toBe(ZH_GOLDEN.profile);
    expect(sha(buildProfilePrompt('subagent'))).toBe(ZH_GOLDEN.profile);
    expect(buildPrompt()).not.toContain(DIRECTIVE);
    expect(sha(buildMaxStepsPrompt())).toBe(ZH_GOLDEN.maxSteps);
  });

  it('en: max-steps prompt has no Chinese and gives English wrap-up examples', async () => {
    const { buildMaxStepsPrompt } = await load('en');
    const prompt = buildMaxStepsPrompt();
    expect(prompt).not.toMatch(/[一-鿿]/);
    expect(prompt).toContain('Reply "continue" and I\'ll pick it up.');
  });

  it('en: synthesized step-limit wrap-up message is English only', async () => {
    const { ensureMaxStepsWrapUp, MAX_STEPS_REASON } = await load('en');
    const { ControlState } = await import('../../../src/host/agent/runtime/controlState');
    const control = ControlState.forTest({});
    control.forceFinalResponse(MAX_STEPS_REASON, 'x');
    const ctx = {
      maxIterations: 4,
      workingDirectory: '/workspace/project',
      control,
      stats: { runStartTime: 100 },
      messages: [],
      circuitBreaker: { isTripped: () => false },
      goalTracker: { getGoalSummary: () => ({ goal: 'tidy downloads', pending: ['sort PDFs'] }) },
      nudgeManager: { getModifiedFilesSince: () => ['notes.md'] },
      onEvent: vi.fn(),
    } as never;
    const persist = vi.fn();
    await ensureMaxStepsWrapUp(ctx, { generateId: () => 'id', addAndPersistMessage: persist }, 4);
    const content = persist.mock.calls[0][0].content as string;
    expect(content).not.toMatch(/[\u4e00-\u9fff]/);
    expect(content).toContain('Reply "continue"');
  });
});
