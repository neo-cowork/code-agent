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
    expect(prompt).toContain('不要出现命令行、终端、端口、进程、shell 等字眼');
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

  it('leaves suggestions untouched when no ban is present', async () => {
    reply('- 总结这份文档\n- 导出为表格');
    const out = await generateContextSuggestions([
      { role: 'user', content: '读一下 curl 的文档' },
      { role: 'assistant', content: '好' },
    ]);
    expect(out.map(s => s.text)).toEqual(['总结这份文档', '导出为表格']);
  });
});
