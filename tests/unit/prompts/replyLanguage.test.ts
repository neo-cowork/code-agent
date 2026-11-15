import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replyLanguageDirective } from '../../../src/host/prompts/communication';
import { formatTodayAnchor } from '../../../src/shared/todayAnchor';

vi.mock('../../../src/host/services', () => ({ getBudgetService: vi.fn() }));

// 改动前在 zh 下抓取的 max-steps 提示词 sha256（纯静态文本，与环境无关）。完整 buildPrompt 的整段 hash 受环境/main 漂移影响（CI 实测不稳），改为 en/zh 结构对比
const ZH_GOLDEN = {
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

  it('zh: prompts carry no directive; en differs from zh only by the directive and the date anchor', async () => {
    const zh = await load('zh');
    const zhPrompt = zh.buildPrompt();
    const zhInteractive = zh.buildProfilePrompt('interactive');
    const zhSubagent = zh.buildProfilePrompt('subagent');
    expect(zhPrompt).not.toContain('<reply_language>');
    expect(zhInteractive).not.toContain('<reply_language>');
    expect(zhSubagent).not.toContain('<reply_language>');

    const en = await load('en');
    const directive = replyLanguageDirective('en');
    expect(directive).toContain(DIRECTIVE);
    expect(replyLanguageDirective('zh')).toBe('');
    const anchor = (lang: 'zh' | 'en') => formatTodayAnchor(new Date(), undefined, lang).prompt;
    const normalize = (text: string, lang: 'zh' | 'en') =>
      text.replace(`${directive}\n\n`, '').replace(anchor(lang), '<ANCHOR>');
    expect(normalize(en.buildPrompt(), 'en')).toBe(normalize(zhPrompt, 'zh'));
    expect(normalize(en.buildProfilePrompt('interactive'), 'en')).toBe(normalize(zhInteractive, 'zh'));
    expect(normalize(en.buildProfilePrompt('subagent'), 'en')).toBe(normalize(zhSubagent, 'zh'));
  });

  it('zh: max-steps prompt is byte-identical to the pre-change output', async () => {
    const { buildMaxStepsPrompt } = await load('zh');
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
