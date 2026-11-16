import { describe, expect, it } from 'vitest';

import { deriveDelegatedSessionTitle } from '../../../../../src/host/tools/modules/delegation/delegatedSessionTitle';

const cp = (value: string) => [...value].length;

// N-FIX-DELEGATE-SESSION-…-TITLE ①：六类输入都给出 ≤20 code points 的短主题；
// 截断的一律以单个 `…`（U+2026）收尾，绝不出现 `...`（`...` 会被
// isProvisionalAutoTitle 当临时档，智能标题会回头改写）。
describe('deriveDelegatedSessionTitle', () => {
  it('60 字符英文句子（无中途句读）截到 19 位 + …，共 20 个 code points', () => {
    const task = 'Turn our weekly meeting notes into three points in an email.';
    expect(cp(task)).toBe(60);
    const title = deriveDelegatedSessionTitle(task);
    expect(cp(title)).toBe(20);
    expect(title).toBe('Turn our weekly mee…');
    expect(title.endsWith('…')).toBe(true);
    expect(title.endsWith('...')).toBe(false);
  });

  it('中文句子：逗号处截断，短于上限不加省略号', () => {
    const title = deriveDelegatedSessionTitle('请把本周会议纪要整理成三个要点，再写一段简短的总结，方便我贴进邮件里发出去。');
    expect(title).toBe('请把本周会议纪要整理成三个要点');
    expect(cp(title)).toBeLessThanOrEqual(20);
    expect(title.endsWith('...')).toBe(false);
  });

  it('无中途句读的 60 字中文句子截断为 20 个 code points', () => {
    const task = '请把我们这周会上讨论过的所有事情都整理成一份既能贴进邮件又能让人一眼看懂的总结并列出三个要点以及下一步行动计划和负责人。';
    expect(cp(task)).toBe(60);
    const title = deriveDelegatedSessionTitle(task);
    expect(cp(title)).toBe(20);
    expect(title.endsWith('…')).toBe(true);
    expect(title.endsWith('...')).toBe(false);
  });

  it('多行文本取第一个非空行', () => {
    const title = deriveDelegatedSessionTitle('\n \nTurn the notes in notes.txt into three key points, then a short summary\nsecond line detail');
    expect(cp(title)).toBe(20);
    expect(title.startsWith('Turn the notes in n')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    expect(title.endsWith('...')).toBe(false);
  });

  it('行首 “- ” 列表标记被剥掉再截断', () => {
    const title = deriveDelegatedSessionTitle('- Turn the meeting notes in notes.txt into three key points and a short summary I can paste into an email');
    expect(cp(title)).toBe(20);
    expect(title.startsWith('- ')).toBe(false);
    expect(title.startsWith('Turn the meeting no')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    expect(title.endsWith('...')).toBe(false);
  });

  it('行首编号标记 “1. ” 被剥掉，逗号前截断', () => {
    const title = deriveDelegatedSessionTitle('1. 整理会议纪要，写成三个要点');
    expect(title).toBe('整理会议纪要');
  });

  it('emoji：25 个火箭 emoji 截到 19 个 + …，按 code points 计数不劈开代理对', () => {
    const title = deriveDelegatedSessionTitle('🚀'.repeat(25));
    expect(cp(title)).toBe(20);
    expect(title).toBe(`${'🚀'.repeat(19)}…`);
    expect(title.endsWith('...')).toBe(false);
  });

  it('emoji 落在截断边界上不被劈成半个代理对', () => {
    const title = deriveDelegatedSessionTitle('一二三四五六七八九十一二三四五六七八🚀九十');
    expect(cp(title)).toBe(20);
    expect(title.endsWith('…')).toBe(true);
    expect(title.endsWith('🚀…')).toBe(true);
    expect(title.endsWith('...')).toBe(false);
  });

  it('中文 + emoji 混排：逗号前截断', () => {
    const title = deriveDelegatedSessionTitle('整理纪要🚀发给团队，越快越好');
    expect(title).toBe('整理纪要🚀发给团队');
  });

  it('两端引号被剥掉（直弯、中西式）', () => {
    expect(deriveDelegatedSessionTitle('"Turn the notes into three key points and a summary email for me"')).toMatch(/^Turn the notes into/);
    const title = deriveDelegatedSessionTitle('「整理会议纪要成三个要点，写总结」');
    expect(title).toBe('整理会议纪要成三个要点');
  });

  it('空文本与纯空白降级为 Delegated session', () => {
    expect(deriveDelegatedSessionTitle('')).toBe('Delegated session');
    expect(deriveDelegatedSessionTitle('  \n \t\n  ')).toBe('Delegated session');
    expect(deriveDelegatedSessionTitle(null)).toBe('Delegated session');
    expect(deriveDelegatedSessionTitle(undefined)).toBe('Delegated session');
  });

  it('恰好 20 个 code points 原样保留，21 个才截断', () => {
    const exactly20 = '一二三四五六七八九十一二三四五六七八九十';
    expect(cp(exactly20)).toBe(20);
    expect(deriveDelegatedSessionTitle(exactly20)).toBe(exactly20);
    const truncated = deriveDelegatedSessionTitle(`${exactly20}一`);
    expect(cp(truncated)).toBe(20);
    expect(truncated.endsWith('…')).toBe(true);
    expect(truncated.endsWith('...')).toBe(false);
  });

  it('真实工单示例：notes.txt 的句点被当句读，标题仍是 ≤20 的可读短主题', () => {
    const title = deriveDelegatedSessionTitle('Open a new chat and have it turn the meeting notes in notes.txt into three key points and a short summary I can paste into an email');
    expect(cp(title)).toBe(20);
    expect(title).toBe('Open a new chat and…');
    expect(title.endsWith('...')).toBe(false);
  });
});
