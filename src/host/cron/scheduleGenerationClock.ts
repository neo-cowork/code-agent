import { formatTodayAnchor } from '../../shared/todayAnchor';

function zonedParts(date: Date, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(
    type => Number(parts.find(part => part.type === type)?.value),
  );
}

/** One captured host clock/zone for the generation prompt and its returned wall time. */
export function buildScheduleGenerationClock(now: Date, timeZone: string): {
  anchor: string;
  toTimestamp: (datetime: unknown) => number;
} {
  const today = formatTodayAnchor(now, timeZone);
  const [, , , hour, minute] = zonedParts(now, timeZone);
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return {
    anchor: `\n\n${today.prompt}\n【当前时间】${today.isoDate} ${clock}（本地时间，IANA 时区 ${timeZone}）。`
      + '用户用「今天/明天/今晚/本周/下周」等相对时间时，必须以此本地日期和时间为基准，'
      + '生成的 at 类型 datetime 绝不能早于当前时间。'
      + 'at 类型只写本地墙上时间 YYYY-MM-DDTHH:mm，不要加 Z 或时区偏移，不要转换成 UTC；时区换算由主机完成。',
    toTimestamp(datetime: unknown): number {
      // Numeric instants already satisfy the downstream string-or-number contract.
      if (typeof datetime === 'number' && Number.isFinite(datetime) && !Number.isNaN(new Date(datetime).getTime())) return datetime;
      const match = typeof datetime === 'string'
        ? datetime.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|[+-]\d{2}:?\d{2})?$/i)
        : null;
      if (!match) throw new Error('CRON_INVALID_LOCAL_DATETIME');
      const [, year, month, day, hours, minutes, seconds = '0', fraction = '0'] = match;
      const target = [year, month, day, hours, minutes, seconds].map(Number);
      const [y, m, d, h, min, sec] = target;
      const date = new Date(0);
      date.setUTCFullYear(y, m - 1, d);
      date.setUTCHours(h, min, sec, Number(fraction.padEnd(3, '0')));
      const wall = date.getTime();
      // Probe both sides of the requested date, then verify each candidate with Intl.
      // This re-evaluates DST at the target, rather than applying today's offset.
      // A gap has no matching instant (reject); a fold uses the earlier occurrence.
      const candidates = [-1, 0, 1].map(dayOffset => {
        const probe = wall + dayOffset * 86_400_000;
        const [py, pm, pd, ph, pmin, ps] = zonedParts(new Date(probe), timeZone);
        const offset = Date.UTC(py, pm - 1, pd, ph, pmin, ps) - Math.floor(probe / 1000) * 1000;
        return wall - offset;
      }).filter(candidate => zonedParts(new Date(candidate), timeZone).every((part, i) => part === target[i]));
      if (!candidates.length) throw new Error('CRON_INVALID_LOCAL_DATETIME');
      return Math.min(...candidates);
    },
  };
}
