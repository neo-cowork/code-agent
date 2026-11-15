import { describe, expect, it } from 'vitest';
import { buildSessionTitlePrompt, detectMessageLanguage } from '../../../src/shared/sessionTitlePrompt';

describe('detectMessageLanguage', () => {
  it('detects Chinese when Chinese shell/file requests include long ASCII paths, URLs, or CLI commands', () => {
    expect(detectMessageLanguage('请把 ~/Desktop/neo-old-notes.txt 删掉')).toBe('zh');
    expect(detectMessageLanguage('请把~/Desktop/neo-old-notes.txt删掉')).toBe('zh');
    expect(detectMessageLanguage('~/Desktop/会议纪要.docx删掉')).toBe('zh');
    expect(detectMessageLanguage('请把 ~/Desktop/neo-old-notes.txt 删掉，已经不需要了。')).toBe('zh');
    expect(detectMessageLanguage('帮我运行 npm run build')).toBe('zh');
    expect(detectMessageLanguage('运行 npm run build')).toBe('zh');
    expect(detectMessageLanguage('运行 npm install express typescript vitest')).toBe('zh');
    expect(detectMessageLanguage('跑一下 git push origin main')).toBe('zh');
    expect(detectMessageLanguage('看下 src/host/agent/runtime/foregroundShellDenial.ts')).toBe('zh');
    expect(detectMessageLanguage('每天检查 https://docs.anthropic.com/en/docs/claude-code/overview 的更新')).toBe('zh');
  });

  it('detects English for English requests even when referencing CJK paths, filenames, or short terms', () => {
    expect(detectMessageLanguage("Please delete ~/Desktop/neo-old-notes.txt, I don't need it any more.")).toBe('en');
    expect(detectMessageLanguage("Please delete ~/Desktop/会议纪要-2026年11月最终版.docx, I don't need it any more.")).toBe('en');
    expect(detectMessageLanguage('Delete ~/Desktop/会议纪要-2026年11月最终版.docx')).toBe('en');
    expect(detectMessageLanguage('Delete 会议纪要-2026年11月最终版.docx')).toBe('en');
    expect(detectMessageLanguage('Please run npm run build')).toBe('en');
    expect(detectMessageLanguage('git is not installed')).toBe('en');
    expect(detectMessageLanguage('Translate 你好 into English')).toBe('en');
    expect(detectMessageLanguage('Please review the 登录 flow and list every bug you can find in the redirect handler')).toBe('en');
  });

  it('returns undefined when no natural-language prose is present so callers fall back to UI language', () => {
    expect(detectMessageLanguage('')).toBeUndefined();
    expect(detectMessageLanguage('12345 ??? 😀')).toBeUndefined();
    expect(detectMessageLanguage('~/Desktop/neo-old-notes.txt')).toBeUndefined();
    expect(detectMessageLanguage('https://example.com/a/b/c')).toBeUndefined();
    expect(detectMessageLanguage('`npm run build`')).toBeUndefined();
    expect(detectMessageLanguage('npm run build')).toBeUndefined();
  });

  it('buildSessionTitlePrompt asks for a Chinese title on Chinese requests containing long ASCII paths', () => {
    const prompt = buildSessionTitlePrompt('请把 ~/Desktop/neo-old-notes.txt 删掉，已经不需要了。', 'zh');
    expect(prompt).toContain('Write the title in Chinese');
  });
});
