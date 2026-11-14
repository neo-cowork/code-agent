type PromptLanguage = 'zh' | 'en';

function readUserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * Lists this week's and next week's days (Monday-first) with dates so the model
 * reads relative dates ("this Friday", "next Monday") off a table instead of
 * doing weekday arithmetic. Built from the same year/month/day parts as isoDate.
 */
function formatWeekCalendar(
  year: number,
  month: number,
  day: number,
  locale: string,
  language: PromptLanguage,
): string {
  const today = Date.UTC(year, month - 1, day);
  const mondayOffset = (new Date(today).getUTCDay() + 6) % 7;
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const entry = (offset: number): string => {
    const parts = formatter.formatToParts(new Date(today + offset * 86_400_000));
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((item) => item.type === type)?.value ?? '';
    const weekday = language === 'en' ? get('weekday') : get('weekday').replace('周', '');
    return `${weekday}${language === 'en' ? ' ' : ''}${get('month')}-${get('day')}`;
  };
  const week = (startOffset: number): string =>
    Array.from({ length: 7 }, (_, index) => entry(startOffset + index)).join(' ');
  const thisWeek = week(-mondayOffset);
  const nextWeek = week(7 - mondayOffset);
  return language === 'en'
    ? `Calendar: this week ${thisWeek}; next week ${nextWeek}`
    : `日历：本周 ${thisWeek}；下周 ${nextWeek}`;
}

/**
 * Formats the user's current calendar date once for every prompt consumer.
 * Keep callers on these returned date parts so the system prompt, web search,
 * and cron prompts cannot drift onto independently calculated dates.
 */
export function formatTodayAnchor(
  now: Date = new Date(),
  timeZone: string = readUserTimeZone(),
  language: PromptLanguage = 'zh',
): {
  prompt: string;
  isoDate: string;
  year: number;
  month: number;
  day: number;
} {
  const locale = language === 'en' ? 'en-US' : 'zh-CN';
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  const year = Number(part('year'));
  const month = Number(part('month'));
  const day = Number(part('day'));
  const weekday = part('weekday');
  const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const previousYear = year - 1;
  const calendar = formatWeekCalendar(year, month, day, locale, language);
  const prompt = language === 'en'
    ? `Today's date: ${isoDate} (${weekday}).\nThe current year is ${year}, not ${previousYear} — treat this date as authoritative.\n${calendar}`
    : `今天的日期：${isoDate}（${weekday}）。\n当前年份是 ${year}，不是 ${previousYear}；请将此日期视为权威信息。\n${calendar}`;

  return { prompt, isoDate, year, month, day };
}
