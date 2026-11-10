import { afterEach, describe, expect, it } from 'vitest';
import { buildCronAgentPrompt } from '../../../src/host/cron/cronAgentPrompt';
import { stripCronPromptDecoration } from '../../../src/shared/cronRunMessage';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

function build(hostTz: string, iso: string, zone?: string): string {
  process.env.TZ = hostTz;
  return buildCronAgentPrompt('查邮件', null, false, new Date(iso), undefined, undefined, zone);
}
const epochs = (p: string) => ({
  date: /今天本地日期是 (\d{4}-\d{2}-\d{2})/.exec(p)?.[1],
  today: Number(/今天本地 00:00 = (\d+)/.exec(p)?.[1]),
  tomorrow: Number(/次日本地 00:00 = (\d+)/.exec(p)?.[1]),
});

describe('cron prompt uses the job timezone', () => {
  it('00:10 Beijing (UTC 16:10 previous day) is the next local date, same under any host TZ', () => {
    const iso = '2026-10-25T16:10:00Z';
    const a = build('UTC', iso, 'Asia/Shanghai');
    const b = build('America/Los_Angeles', iso, 'Asia/Shanghai');
    expect(a).toBe(b);
    expect(epochs(a)).toEqual({ date: '2026-10-26', today: Date.parse('2026-10-26T00:00:00+08:00') / 1000, tomorrow: Date.parse('2026-10-27T00:00:00+08:00') / 1000 });
    expect(a).toContain('Asia/Shanghai');
    expect(a).toContain('2026-10-26 00:10');
  });

  it('11:04 Beijing is 2026-10-29, same under any host TZ', () => {
    const iso = '2026-10-29T03:04:00Z';
    const a = build('UTC', iso, 'Asia/Shanghai');
    expect(a).toBe(build('America/Los_Angeles', iso, 'Asia/Shanghai'));
    expect(epochs(a).date).toBe('2026-10-29');
    expect(epochs(a).today).toBe(Date.parse('2026-10-29T00:00:00+08:00') / 1000);
    expect(a).toContain('2026-10-29 11:04');
  });

  it('without a timezone the host zone still leaks (proves the TZ switch is effective)', () => {
    const iso = '2026-10-29T03:04:00Z';
    expect(epochs(build('UTC', iso)).date).toBe('2026-10-29');
    expect(epochs(build('America/Los_Angeles', iso)).date).toBe('2026-10-28');
  });

  it('tomorrow is the next local midnight across a DST day (America/Los_Angeles 2026-11-01 is 25h)', () => {
    const e = epochs(build('UTC', '2026-11-01T12:00:00Z', 'America/Los_Angeles'));
    expect(e.date).toBe('2026-11-01');
    expect(e.today).toBe(Date.parse('2026-11-01T00:00:00-07:00') / 1000);
    expect(e.tomorrow).toBe(Date.parse('2026-11-02T00:00:00-08:00') / 1000);
    expect(e.tomorrow - e.today).toBe(25 * 3600);
  });

  it('invalid timezone falls back to the host zone without throwing', () => {
    const iso = '2026-10-29T03:04:00Z';
    expect(() => build('America/Los_Angeles', iso, 'Not/AZone')).not.toThrow();
    expect(build('America/Los_Angeles', iso, 'Not/AZone')).toBe(build('America/Los_Angeles', iso));
  });

  it('keeps the UTC prefix so the chat bubble still strips the machine tail', () => {
    const p = build('UTC', '2026-10-29T03:04:00Z', 'Asia/Shanghai');
    expect(p).toContain('\n\n【当前时间】2026-10-29T03:04:00.000Z（UTC）。');
    expect(stripCronPromptDecoration(p)).toBe('查邮件');
  });
});
