import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DYNAMIC_BOUNDARY_MARKER } from '../../../src/host/prompts/cacheBreakDetection';
import { formatTodayAnchor } from '../../../src/shared/todayAnchor';

describe('today prompt anchor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds the fixed current date and authoritative year to the system prompt', async () => {
    const { buildPrompt } = await import('../../../src/host/prompts/builder');
    const prompt = buildPrompt();

    expect(prompt).toContain('2026-08-25');
    expect(prompt).toMatch(/当前年份是 2026，不是 2025|The current year is 2026, not 2025/);
  });

  it('places the date anchor before the dynamic boundary marker', async () => {
    const { buildPrompt } = await import('../../../src/host/prompts/builder');
    const prompt = buildPrompt();
    const anchor = formatTodayAnchor();

    expect(prompt.indexOf(anchor.prompt)).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf(anchor.prompt)).toBeLessThan(prompt.indexOf(DYNAMIC_BOUNDARY_MARKER));
  });

  it('formats equivalent English and Chinese anchors in the user timezone', () => {
    const now = new Date('2026-08-25T00:30:00.000Z');

    expect(formatTodayAnchor(now, 'Asia/Shanghai', 'en').prompt).toBe(
      "Today's date: 2026-08-25 (Tuesday).\nThe current year is 2026, not 2025 — treat this date as authoritative.\n" +
        'Calendar: this week Mon 08-24 Tue 08-25 Wed 08-26 Thu 08-27 Fri 08-28 Sat 08-29 Sun 08-30; ' +
        'next week Mon 08-31 Tue 09-01 Wed 09-02 Thu 09-03 Fri 09-04 Sat 09-05 Sun 09-06',
    );
    expect(formatTodayAnchor(now, 'Asia/Shanghai', 'zh').prompt).toBe(
      '今天的日期：2026-08-25（星期二）。\n当前年份是 2026，不是 2025；请将此日期视为权威信息。\n' +
        '日历：本周 一08-24 二08-25 三08-26 四08-27 五08-28 六08-29 日08-30；' +
        '下周 一08-31 二09-01 三09-02 四09-03 五09-04 六09-05 日09-06',
    );
  });

  it('maps 本周五 / 下周一 / 下周五之后的周一 on the Thursday 2026-11-12 from the calendar line', () => {
    const { prompt } = formatTodayAnchor(new Date('2026-11-12T04:00:00.000Z'), 'Asia/Shanghai', 'zh');

    expect(prompt).toContain('今天的日期：2026-11-12（星期四）');
    expect(prompt).toContain('五11-13');
    expect(prompt).toContain('下周 一11-16');
    expect(prompt).toContain('五11-20');
  });

  it('keeps the calendar correct across a month boundary', () => {
    const { prompt } = formatTodayAnchor(new Date('2026-10-29T04:00:00.000Z'), 'Asia/Shanghai', 'zh');

    expect(prompt).toContain('本周 一10-26 二10-27 三10-28 四10-29 五10-30 六10-31 日11-01');
    expect(prompt).toContain('下周 一11-02');
  });

  it('treats Sunday as the last day of the current week, not the first', () => {
    const { prompt } = formatTodayAnchor(new Date('2026-11-15T04:00:00.000Z'), 'Asia/Shanghai', 'en');

    expect(prompt).toContain("Today's date: 2026-11-15 (Sunday)");
    expect(prompt).toContain('this week Mon 11-09 Tue 11-10 Wed 11-11 Thu 11-12 Fri 11-13 Sat 11-14 Sun 11-15; next week Mon 11-16');
  });

  it('pins the weekday anchor and calendar line into the system prompt on Thursday 2026-11-12', async () => {
    vi.setSystemTime(new Date('2026-11-12T12:00:00.000Z'));
    const { buildPrompt } = await import('../../../src/host/prompts/builder');
    const prompt = buildPrompt();
    const expected = formatTodayAnchor(new Date(), undefined, 'zh').prompt;

    expect(prompt).toContain('2026-11-12');
    expect(prompt).toContain(expected.split('\n')[2]);
    expect(prompt.indexOf('日历：')).toBeLessThan(prompt.indexOf(DYNAMIC_BOUNDARY_MARKER));
  });
});
