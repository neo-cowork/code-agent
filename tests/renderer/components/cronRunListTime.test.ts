import { describe, expect, it } from 'vitest';
import { formatRunListTime } from '../../../src/renderer/components/features/cron/types';

// N-CRON-RUN-LEDGER-VISIBLE-FU2-AFTERP2 ②：钉 formatRunListTime 行为
// （死三元移除后行为必须逐字不变）。
describe('formatRunListTime (run-list time column)', () => {
  it('number input and ISO string of the same instant give the same MM/DD HH:mm text', () => {
    const ms = 1760000000000; // 2025-10-09T04:53:20Z → 本地时区稳定取同一 Date 的字段
    expect(formatRunListTime(ms)).toBe(formatRunListTime(new Date(ms).toISOString()));
  });

  it('pads month/day/hour/minute to two digits', () => {
    const d = new Date(2023, 1, 5, 7, 8, 0);
    const text = formatRunListTime(d.getTime());
    expect(text).toMatch(/^(?:2023\/)?02\/05 07:08$/);
    const [datePart, hm] = text.split(' ');
    datePart.split('/').slice(-2).concat(hm.split(':')).forEach((part) => expect(part).toHaveLength(2));
  });

  it('undefined gives the dash', () => {
    expect(formatRunListTime(undefined)).toBe('—');
  });

  it('invalid string gives the dash', () => {
    expect(formatRunListTime('not-a-date')).toBe('—');
  });
});
