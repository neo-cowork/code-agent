// ============================================================================
// 回复语言：旧模板 SOUL.md 不得与 <reply_language> 打架（FB-1513 加固）
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../src/host/services', () => ({ getBudgetService: vi.fn() }));

const LEGACY_SOUL = `# Agent Neo — Core Self

## 交互风格

- 用中文沟通，直接给结论不绕弯
- 不废话，不做无用的 preamble / postamble
`;

async function assemble(language: 'zh' | 'en', soul: string | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-reply-lang-'));
  if (soul !== null) fs.writeFileSync(path.join(dir, 'SOUL.md'), soul, 'utf-8');
  process.env.CODE_AGENT_DATA_DIR = dir;
  vi.resetModules();
  vi.doMock('../../../src/host/services/core/configService', () => ({
    getConfigService: () => ({ getSettings: () => ({ ui: { language } }) }),
  }));
  const { buildPrompt } = await import('../../../src/host/prompts/builder');
  const { loadSoul, getSoul } = await import('../../../src/host/prompts/soulLoader');
  loadSoul();
  const result = { prompt: buildPrompt(), soul: getSoul(), dir };
  return result;
}

const replyLanguageLines = (text: string) =>
  text.split('\n').filter((l) => /用中文沟通|Reply in English by default|Reply in the user's language/.test(l));

describe('回复语言指令不自相矛盾', () => {
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;
  const dirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../../../src/host/services/core/configService');
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('en + 旧模板 SOUL.md：「用中文沟通」被中立化，prompt 只剩英文指令', async () => {
    const { prompt, dir } = await assemble('en', LEGACY_SOUL);
    dirs.push(dir);
    expect(prompt).not.toContain('用中文沟通');
    expect(prompt).toContain("- Reply in the user's language，直接给结论不绕弯");
    expect(prompt.split('<reply_language>').length - 1).toBe(1);
    // 文件本身不被改写
    expect(fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf-8')).toBe(LEGACY_SOUL);
    console.log(replyLanguageLines(prompt).join('\n'));
  });

  it('en + 无 SOUL.md：只有一条 <reply_language>，没有中文沟通指令', async () => {
    const { prompt, dir } = await assemble('en', null);
    dirs.push(dir);
    expect(prompt).not.toContain('用中文沟通');
    expect(prompt.split('<reply_language>').length - 1).toBe(1);
  });

  it('zh + 旧模板 SOUL.md：原样保留，不下发英文指令（字节不变）', async () => {
    const { prompt, soul, dir } = await assemble('zh', LEGACY_SOUL);
    dirs.push(dir);
    expect(soul).toContain('- 用中文沟通，直接给结论不绕弯');
    expect(prompt).toContain('- 用中文沟通，直接给结论不绕弯');
    expect(prompt).not.toContain('<reply_language>');
    expect(prompt).not.toContain('Reply in English by default');
    expect(prompt).not.toContain("Reply in the user's language");
  });

  it('zh + 无 SOUL.md：没有任何回复语言指令', async () => {
    const { prompt, dir } = await assemble('zh', null);
    dirs.push(dir);
    expect(prompt).not.toContain('<reply_language>');
    expect(prompt).not.toContain('用中文沟通');
  });

  it('新模板（init-soul 产物）en/zh 都不钉语言', async () => {
    const SOUL_TEMPLATE = String((await import('../../../src/host/prompts/templates/soulTemplates')).SOUL_TEMPLATE);
    expect(SOUL_TEMPLATE).not.toContain('用中文');
    for (const lang of ['en', 'zh'] as const) {
      const { prompt, dir } = await assemble(lang, SOUL_TEMPLATE);
      dirs.push(dir);
      expect(prompt).not.toContain('用中文');
      expect(prompt.split('<reply_language>').length - 1).toBe(lang === 'en' ? 1 : 0);
    }
  });
});
