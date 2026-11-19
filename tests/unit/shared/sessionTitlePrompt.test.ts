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

describe('explicit reply-language directive', () => {
  const excel = 'Export the sales spreadsheet to Excel and add a total row.';
  it('lets a Chinese directive win over an English body', () => {
    expect(detectMessageLanguage(`${excel} 请用中文回复。`)).toBe('zh');
    expect(buildSessionTitlePrompt(`${excel} 请用中文回复。`, 'zh')).toContain('Write the title in Chinese');
  });
  it('lets an English directive win over a Chinese body', () => {
    expect(detectMessageLanguage('Reply in English. 帮我把销售表导出成 Excel，并加合计行。')).toBe('en');
    expect(detectMessageLanguage('请用英文回复。帮我把销售表导出成 Excel，并加合计行。')).toBe('en');
  });
  it('keeps plain English and non-directive translate requests unchanged', () => {
    expect(detectMessageLanguage(excel)).toBe('en');
    expect(detectMessageLanguage('Translate 你好 into English')).toBe('en');
    expect(detectMessageLanguage('把这段翻译成英文')).toBe('zh');
    expect(detectMessageLanguage('请把 ~/Desktop/x.txt 删掉')).toBe('zh');
  });
  it('ignores directives inside code', () => {
    expect(detectMessageLanguage(`${excel}\n\`\`\`\n请用中文回复\n\`\`\``)).toBe('en');
  });
  it('uses the later of two conflicting directives', () => {
    expect(detectMessageLanguage('Reply in English. 另外请用中文回复。')).toBe('zh');
    expect(detectMessageLanguage('请用中文回复。Actually, please reply in English.')).toBe('en');
  });
  it('does not treat negated, word-internal or noun uses as a directive', () => {
    expect(detectMessageLanguage('不要用英文回复，这段 bug 怎么修')).toBe('zh');
    expect(detectMessageLanguage('别用英文回答，帮我看看这个 bug')).toBe('zh');
    expect(detectMessageLanguage('所以英文回答被评委打回来了，帮我改标题')).toBe('zh');
    expect(detectMessageLanguage('The answer in Chinese is wrong; fix the docs, the tests, and the comments.')).toBe('en');
    expect(detectMessageLanguage("Please don't reply in Chinese, just fix the failing tests in the module.")).toBe('en');
  });
  it('still accepts imperative English and polite Chinese forms', () => {
    expect(detectMessageLanguage('Fix the failing tests in the module and please reply in Chinese.')).toBe('zh');
    expect(detectMessageLanguage('Fix the failing tests in the module, answer in Chinese.')).toBe('zh');
    expect(detectMessageLanguage('Fix the failing tests in the module. 要用中文回答。')).toBe('zh');
  });
});
