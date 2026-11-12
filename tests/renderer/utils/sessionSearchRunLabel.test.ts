import { describe, expect, it } from 'vitest';
import { resolveSearchRunLabels } from '../../../src/renderer/utils/sessionSearchRunLabel';
import { formatLocalDateTime } from '../../../src/renderer/utils/i18nTime';

describe('resolveSearchRunLabels seconds labels', () => {
  const ts = new Date(new Date().getFullYear(), 10, 8, 16, 1, 7).getTime();

  const withSecondsLabel = (label: string, timestamp: number) => {
    const row = { title: 'Daily notes', label, updatedAt: timestamp, createdAt: timestamp };
    return resolveSearchRunLabels([row, { ...row }]).labels[0];
  };

  it.each(['zh', 'en'] as const)('adds seconds and removing them restores the normal label (%s)', (lang) => {
    const label = formatLocalDateTime(ts, lang);
    const withSeconds = withSecondsLabel(label, ts);
    expect(withSeconds).not.toBe(label);
    expect(withSeconds).toMatch(/\d{1,2}:\d{2}:07/);
    expect(withSeconds.replace(/(\d{1,2}:\d{2}):07/, '$1')).toBe(label);
  });

  it('handles 12h and 24h samples', () => {
    expect(withSecondsLabel('Nov 8, 4:01 PM', ts)).toBe('Nov 8, 4:01:07 PM');
    expect(withSecondsLabel('11月8日 16:01', ts)).toBe('11月8日 16:01:07');
    expect(withSecondsLabel('11月8日 09:05', ts)).toBe('11月8日 09:05:07');
  });

  it('appends :SS when no time token is present', () => {
    expect(withSecondsLabel('whatever', ts)).toBe('whatever:07');
  });
});
