import { beforeEach, describe, expect, it, vi } from 'vitest';

const quickTask = vi.fn();
vi.mock('../../../src/host/model/quickModel', () => ({ quickTask }));

import { generateContextSuggestions } from '../../../src/host/services/core/promptSuggestions';

const reply = (content: string) => quickTask.mockResolvedValue({ success: true, content });

describe('generateContextSuggestions', () => {
  beforeEach(() => quickTask.mockReset());

  it('prompt carries the refusal and plain-language rules, and an old ban beyond the old window', async () => {
    reply('把页面内容贴给我');
    const messages = [
      { role: 'user', content: '请不要用 Bash 或 curl，公司电脑禁用命令行' + 'x'.repeat(400) + 'TAIL_MARK' },
      ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `msg${i}` })),
    ];
    await generateContextSuggestions(messages);
    const prompt = quickTask.mock.calls[0][0] as string;
    expect(prompt).toContain('尊重用户在对话中提出的任何拒绝、禁止、限制或偏好，后说的优先');
    expect(prompt).toContain('不要出现命令行、终端、端口、进程、shell、ping、工具、后台任务、代理等技术字眼');
    expect(prompt).toContain('请不要用 Bash 或 curl'); // 9th-from-last message, outside old 6-window
    expect(prompt).toContain('TAIL_MARK'); // beyond old 300-char cut
  });

  it('drops suggestions that contain a term the user banned', async () => {
    reply('重新执行该 curl 命令\n把页面内容贴给我\n告诉我这个地址是做什么的');
    const out = await generateContextSuggestions([
      { role: 'user', content: '读一下这个地址' },
      { role: 'assistant', content: '我用 curl 试了' },
      { role: 'user', content: '不要用 Bash/curl，公司电脑拦命令行' },
      { role: 'assistant', content: '好的' },
    ]);
    expect(out.map(s => s.text)).toEqual(['把页面内容贴给我', '告诉我这个地址是做什么的']);
  });

  it('handles English bans case-insensitively and returns [] when all dropped', async () => {
    reply('Run CURL again\nUse curl -v');
    const out = await generateContextSuggestions([
      { role: 'user', content: "Please don't use curl here" },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(out).toEqual([]);
  });

  it('takes whole words at the window edge (no partial term like "cur")', async () => {
    reply('Check the occurrence log\nRetry curl once more');
    const out = await generateContextSuggestions([
      { role: 'user', content: "please don't use Bash or curl for this" },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(out.map(s => s.text)).toEqual(['Check the occurrence log']);
  });

  it('FB-704 set: filter drops the curl chip; port/process chips are guarded only by the prompt rule', async () => {
    reply('重新执行该 curl 命令\n检查 18931 端口是否在监听\n查看占用端口的进程');
    const out = await generateContextSuggestions([
      { role: 'user', content: '读一下 http://192.168.1.20:18931/status' },
      { role: 'assistant', content: '我用 curl 试了，连不上' },
      { role: 'user', content: '不要用 Bash 或 curl，公司电脑拦命令行，原因是安全策略' },
      { role: 'assistant', content: '好的，不用命令行' },
    ]);
    // The user only banned bash/curl: the deterministic filter removes just the curl chip.
    expect(out.map(s => s.text)).toEqual(['检查 18931 端口是否在监听', '查看占用端口的进程']);
    // The prompt (not the filter) is what keeps port/process wording out of chips.
    expect(quickTask.mock.calls[0][0]).toContain('不要出现命令行、终端、端口、进程');
  });

  it('a non-ban phrase like "不能打开 PDF" no longer drops chips naming pdf', async () => {
    reply('把 PDF 转成文字\n直接贴文字内容给我');
    const out = await generateContextSuggestions([
      { role: 'user', content: '我不能打开 PDF 文件' },
      { role: 'assistant', content: '好的' },
    ]);
    expect(out.map(s => s.text)).toEqual(['把 PDF 转成文字', '直接贴文字内容给我']);
  });

  it('leaves suggestions untouched when no ban is present', async () => {
    reply('- 总结这份文档\n- 导出为表格');
    const out = await generateContextSuggestions([
      { role: 'user', content: '读一下 curl 的文档' },
      { role: 'assistant', content: '好' },
    ]);
    expect(out.map(s => s.text)).toEqual(['总结这份文档', '导出为表格']);
  });
});

describe('generateContextSuggestions ban extraction is narrow', () => {
  beforeEach(() => quickTask.mockReset());
  const run = async (userText: string, chips: string) => {
    quickTask.mockResolvedValue({ success: true, content: chips });
    const out = await generateContextSuggestions([
      { role: 'user', content: userText },
      { role: 'assistant', content: 'ok' },
    ]);
    return out.map(s => s.text);
  };

  it("\"don't put it in the README\" bans nothing (no 'in' substring wipe-out)", async () => {
    expect(await run("don't put it in the README", 'Explain the plan\nFind integration tests')).toEqual([
      'Explain the plan',
      'Find integration tests',
    ]);
  });

  it('"No, use Python instead" does not ban python', async () => {
    expect(await run('No, use Python instead', 'Run the Python script')).toEqual(['Run the Python script']);
  });

  it('「识别 / 区别 / 特别 / 别的」 do not trigger a ban', async () => {
    expect(await run('帮我识别这张图里的 Excel 表格，特别是区别和别的列', '导出 Excel 表格')).toEqual(['导出 Excel 表格']);
  });

  it('「不用担心，React 那边我来」 bans nothing', async () => {
    expect(await run('不用担心，React 那边我来', '检查 React 组件')).toEqual(['检查 React 组件']);
  });

  it('explicit bans still work, with whole-word matching', async () => {
    expect(await run("don't use curl or wget", 'Retry with CURL\nUse wget again\nUse curly braces')).toEqual(['Use curly braces']);
    expect(await run('别用 Bash/curl', '再跑一次 bash 命令\n把内容发给我')).toEqual(['把内容发给我']);
  });

  it('a ban older than the 10-message window no longer applies', async () => {
    quickTask.mockResolvedValue({ success: true, content: '再用 curl 试试' });
    const msgs = [{ role: 'user', content: '不要用 curl' }, ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `m${i}` }))];
    expect((await generateContextSuggestions(msgs)).map(s => s.text)).toEqual(['再用 curl 试试']);
  });
});

describe('generateContextSuggestions ban list stops at the end of the ban clause', () => {
  beforeEach(() => quickTask.mockReset());
  const run = async (userText: string, chips: string) => {
    quickTask.mockResolvedValue({ success: true, content: chips });
    const out = await generateContextSuggestions([
      { role: 'user', content: userText },
      { role: 'assistant', content: 'ok' },
    ]);
    return out.map(s => s.text);
  };

  it("\"don't use curl, use wget instead\" bans only curl (preferred alternative survives)", async () => {
    expect(await run("don't use curl, use wget instead", 'Use wget instead\nRe-run the curl command\nTry wget with a proxy')).toEqual([
      'Use wget instead',
      'Try wget with a proxy',
    ]);
  });

  it("\"don't use curl and then retry\" bans only curl", async () => {
    expect(await run("don't use curl and then retry", 'Then check the logs\nRetry the curl call')).toEqual(['Then check the logs']);
  });

  it('"don\'t use bash or curl" still bans both names', async () => {
    expect(await run("don't use bash or curl", 'Run bash again\nRetry with curl\nShare the page text')).toEqual(['Share the page text']);
  });

  it('「不要用 curl，改用浏览器」 does not ban 浏览器 and drops only curl', async () => {
    expect(await run('不要用 curl，改用浏览器', '用浏览器打开页面\n再跑一次 curl')).toEqual(['用浏览器打开页面']);
  });

  it('"and" inside a longer word does not extend the list', async () => {
    expect(await run("don't use curl android", 'Open the android app')).toEqual(['Open the android app']);
  });
});
