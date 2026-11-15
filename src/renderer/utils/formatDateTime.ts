// Shared renderer date-time text, independent of machine locale and UI language.
import type { Language } from '../i18n';

/**
 * Full date-time in zh and en: `YYYY/MM/DD HH:mm`, zero padded, 24-hour, no seconds.
 * Uses local time unless a caller already has an explicit timezone (cron schedules).
 * Run tables omit the year only for current-year rows via formatRunListTime.
 */
export function formatDateTime(
  value?: string | number | Date,
  lang: Language = 'zh',
  timeZone?: string,
): string {
  if (value == null) return '未设置';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '无效时间';
  const pad = (part: number) => String(part).padStart(2, '0');
  if (timeZone) {
    const parts = new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}/${byType.month}/${byType.day} ${byType.hour}:${byType.minute}`;
  }
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
