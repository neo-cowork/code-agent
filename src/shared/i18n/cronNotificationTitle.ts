import { cronSessionTitlePrefixes } from '../cronSessionTitle';

export type CronNotificationLocale = keyof typeof cronSessionTitlePrefixes;

export function buildScheduledSessionTitle(locale: CronNotificationLocale, jobName: string): string {
  return `${cronSessionTitlePrefixes[locale].schedule} ${jobName}`;
}

const scheduledPrefixes = [
  ...Object.values(cronSessionTitlePrefixes).map(({ schedule }) => schedule),
  '[Scheduled]',
];
const SCHEDULED_TITLE_PATTERN = new RegExp(
  `(?:${scheduledPrefixes.map((prefix) => prefix.replace(/[[\]]/g, '\\$&')).join('|')})\\s*(.+)$`,
);

/** Extract a job name from a notification title, including previously emitted titles. */
export function parseScheduledJobName(title: string): string | undefined {
  const name = title.match(SCHEDULED_TITLE_PATTERN)?.[1]?.trim();
  return name || undefined;
}
