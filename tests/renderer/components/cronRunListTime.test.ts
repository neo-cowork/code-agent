import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRunListTime } from '../../../src/renderer/components/features/cron/types';
import { formatDateTime } from '../../../src/renderer/utils/formatDateTime';

// N-CRON-RUN-LEDGER-VISIBLE-FU2-AFTERP2 ②：钉 formatRunListTime 行为
// （死三元移除后行为必须逐字不变）。
describe('formatRunListTime (run-list time column)', () => {
  it('number input and ISO string of the same instant give the same MM/DD HH:mm text', () => {
    const ms = 1760000000000; // 2025-10-09T04:53:20Z → 本地时区稳定取同一 Date 的字段
    expect(formatRunListTime(ms, 'zh')).toBe(formatRunListTime(new Date(ms).toISOString(), 'zh'));
  });

  it('pads month/day/hour/minute to two digits', () => {
    const d = new Date(2023, 1, 5, 7, 8, 0);
    const text = formatRunListTime(d.getTime(), 'zh');
    expect(text).toMatch(/^(?:2023\/)?02\/05 07:08$/);
    const [datePart, hm] = text.split(' ');
    datePart.split('/').slice(-2).concat(hm.split(':')).forEach((part) => expect(part).toHaveLength(2));
  });

  it('undefined gives the dash', () => {
    expect(formatRunListTime(undefined, 'zh')).toBe('—');
  });

  it('invalid string gives the dash', () => {
    expect(formatRunListTime('not-a-date', 'zh')).toBe('—');
  });
});

// N-FIX-DATETIME-FORMAT-MIXED-ACROSS-SCREENS ③：短表与详情共用同一套分隔符/补零/24 小时，
// 年份只在非当年行补上（冻结时钟把这条规则钉死，不依赖跑测试那天的日期）。
describe('formatRunListTime year rule (frozen clock, N-FIX-DATETIME-FORMAT-MIXED-ACROSS-SCREENS)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 9)); });
  afterEach(() => vi.useRealTimers());

  it('current-year row stays short and agrees with the full detail text', () => {
    const ms = new Date(2026, 10, 4, 0, 50, 38).getTime();
    expect(formatRunListTime(ms, 'zh')).toBe('11/04 00:50');
    expect(formatRunListTime(new Date(ms).toISOString(), 'zh')).toBe('11/04 00:50');
    expect(formatDateTime(ms, 'en')).toBe(`2026/${formatRunListTime(ms, 'zh')}`);
    expect(formatDateTime(ms, 'zh')).toBe('2026/11/04 00:50');
  });

  it('older and future rows carry the year in the same padded 24-hour shape', () => {
    const ms = new Date(2025, 1, 5, 7, 8, 59).getTime();
    expect(formatRunListTime(ms, 'zh')).toBe('2025/02/05 07:08');
    expect(formatRunListTime(ms, 'zh')).toBe(formatDateTime(ms, 'en'));
    expect(formatRunListTime(new Date(2027, 0, 1, 0, 0).getTime(), 'zh')).toBe('2027/01/01 00:00');
  });

  it('uses the current clock year across New Year', () => {
    const ms = new Date(2026, 11, 31, 23, 59).getTime();
    expect(formatRunListTime(ms, 'zh')).toBe('12/31 23:59');
    vi.setSystemTime(new Date(2027, 0, 1));
    expect(formatRunListTime(ms, 'zh')).toBe('2026/12/31 23:59');
  });
});
