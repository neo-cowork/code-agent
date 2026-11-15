import type { CronHumanLang } from './cronHumanize';

function localeForLanguage(language: CronHumanLang): string {
  return language === 'zh' ? 'zh-CN' : 'en-US';
}

export function resolveTimeZone(timeZone?: string): string | undefined {
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

export function hasDifferentTimeZone(timeZone?: string): timeZone is string {
  const resolved = resolveTimeZone(timeZone);
  return resolved !== undefined && resolved !== machineTimeZone();
}

function getTimeZoneName(timeZone: string, language: CronHumanLang): string | undefined {
  const part = new Intl.DateTimeFormat(localeForLanguage(language), {
    timeZone,
    timeZoneName: 'long',
  }).formatToParts(new Date()).find((item) => item.type === 'timeZoneName');
  return part?.value;
}

function withTimeZoneSuffix(value: string, timeZone: string | undefined, language: CronHumanLang): string {
  if (!timeZone || !hasDifferentTimeZone(timeZone)) return value;
  const zoneName = getTimeZoneName(timeZone, language);
  if (!zoneName) return value;
  return language === 'zh' ? `${value}（${zoneName}）` : `${value} (${zoneName})`;
}

/** Append the configured cron zone name when it differs from this machine. */
export function formatCronTimeZoneSuffix(
  value: string,
  timeZone: string | undefined,
  language: CronHumanLang = 'zh',
): string {
  return withTimeZoneSuffix(value, resolveTimeZone(timeZone), language);
}
