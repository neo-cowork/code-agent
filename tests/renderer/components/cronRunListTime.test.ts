import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRunListTime } from '../../../src/renderer/components/features/cron/types';
import { formatDateTime } from '../../../src/renderer/utils/formatDateTime';

describe('formatRunListTime (run-list time column)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 9)); });
  afterEach(() => vi.useRealTimers());

  it('number and ISO input agree; current-year short text agrees with full detail', () => {
    const ms = new Date(2026, 10, 4, 0, 50, 38).getTime();
    expect(formatRunListTime(ms)).toBe('11/04 00:50');
    expect(formatRunListTime(new Date(ms).toISOString())).toBe('11/04 00:50');
    expect(formatDateTime(ms, 'en')).toBe(`2026/${formatRunListTime(ms)}`);
    expect(formatDateTime(ms, 'zh')).toBe('2026/11/04 00:50');
  });

  it('pads each field and adds the year for older and future rows', () => {
    const ms = new Date(2025, 1, 5, 7, 8, 59).getTime();
    expect(formatRunListTime(ms)).toBe('2025/02/05 07:08');
    expect(formatRunListTime(ms)).toBe(formatDateTime(ms, 'en'));
    expect(formatRunListTime(new Date(2027, 0, 1, 0, 0).getTime())).toBe('2027/01/01 00:00');
  });

  it('uses the current clock year across New Year', () => {
    const ms = new Date(2026, 11, 31, 23, 59).getTime();
    expect(formatRunListTime(ms)).toBe('12/31 23:59');
    vi.setSystemTime(new Date(2027, 0, 1));
    expect(formatRunListTime(ms)).toBe('2026/12/31 23:59');
  });

  it('undefined gives the dash', () => { expect(formatRunListTime(undefined)).toBe('—'); });
  it('invalid string gives the dash', () => { expect(formatRunListTime('not-a-date')).toBe('—'); });
});
