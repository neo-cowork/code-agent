import { formatCronExpressionLabel, type CronHumanLang } from '@shared/cronHumanize';
import type { Language } from '../i18n';
import { formatDateTime } from './formatDateTime';

type TimeZoneParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
};

function localeForLanguage(language: Language): string {
  return language === 'zh' ? 'zh-CN' : 'en-US';
}

function resolveTimeZone(timeZone?: string): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return timeZone;
  } catch {
    return undefined;
  }
}

function machineTimeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function hasDifferentTimeZone(timeZone?: string): timeZone is string {
  const resolved = resolveTimeZone(timeZone);
  return resolved !== undefined && resolved !== machineTimeZone();
}

function getTimeZoneName(timeZone: string, language: Language): string | undefined {
  const part = new Intl.DateTimeFormat(localeForLanguage(language), {
    timeZone,
    timeZoneName: 'long',
  }).formatToParts(new Date()).find((item) => item.type === 'timeZoneName');
  return part?.value;
}

function withTimeZoneSuffix(value: string, timeZone: string | undefined, language: Language): string {
  if (!timeZone || !hasDifferentTimeZone(timeZone)) return value;
  const zoneName = getTimeZoneName(timeZone, language);
  if (!zoneName) return value;
  return language === 'zh' ? `${value}（${zoneName}）` : `${value} (${zoneName})`;
}

/** Append the configured cron zone name when it differs from this machine. */
export function formatCronTimeZoneSuffix(
  value: string,
  timeZone: string | undefined,
  language: Language = 'zh',
): string {
  return withTimeZoneSuffix(value, resolveTimeZone(timeZone), language);
}

function formatZhParts(value: string | number | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value])) as Partial<TimeZoneParts>;
  return `${byType.year}/${byType.month}/${byType.day} ${byType.hour}:${byType.minute}`;
}

/** Full next-run time in the cron job's timezone, naming non-local zones. */
export function formatCronJobDateTime(
  value: string | number | Date,
  timeZone: string | undefined,
  language: Language = 'zh',
): string {
  const resolved = resolveTimeZone(timeZone);
  if (!resolved) return formatDateTime(value, language);
  const formatted = language === 'zh'
    ? formatZhParts(value, resolved)
    : new Date(value).toLocaleString('en-US', { timeZone: resolved });
  return withTimeZoneSuffix(formatted, resolved, language);
}

/** Machine-local next-run time for the detail page's comparison line. */
export function formatCronJobLocalDateTime(value: string | number | Date, language: Language = 'zh'): string {
  return formatDateTime(value, language);
}

/** Whether the configured cron timezone is valid and differs from this machine. */
export function cronJobUsesDifferentTimeZone(timeZone?: string): boolean {
  return hasDifferentTimeZone(timeZone);
}

/** Cron schedule label with the same timezone suffix as its next-run time. */
export function formatCronScheduleLabelWithZone(
  expression: string,
  timeZone: string | undefined,
  language: CronHumanLang = 'zh',
): string {
  const base = formatCronExpressionLabel(expression, timeZone, language);
  return formatCronTimeZoneSuffix(base, timeZone, language);
}

/** Short next-run time used by the sidebar and project rail. */
export function formatCronJobShortTime(
  value: string | number | Date,
  timeZone: string | undefined,
  language: Language = 'zh',
): string {
  const resolved = resolveTimeZone(timeZone);
  const locale = localeForLanguage(language);
  if (!resolved) {
    const date = new Date(value);
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return time;
    return `${date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })} ${time}`;
  }

  const date = new Date(value);
  const dayFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolved,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const sameDay = dayFormatter.format(date) === dayFormatter.format(new Date());
  const time = date.toLocaleTimeString(locale, {
    timeZone: resolved,
    hour: '2-digit',
    minute: '2-digit',
  });
  const formatted = sameDay
    ? time
    : `${date.toLocaleDateString(locale, { timeZone: resolved, month: 'numeric', day: 'numeric' })} ${time}`;
  return withTimeZoneSuffix(formatted, resolved, language);
}
