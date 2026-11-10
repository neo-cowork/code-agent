// ============================================================================
// 定时任务系统通知标题（zh/en）
// host 用 buildScheduledSessionTitle 生成「[定时] 名称 / [Scheduled] name」，
// renderer 用 parseScheduledJobName 从任意一种前缀还原任务名——两端同源，改前缀只改这里。
// ============================================================================
export type CronNotificationLocale = 'zh' | 'en';

const SCHEDULED_PREFIX: Record<CronNotificationLocale, string> = {
  zh: '[定时]',
  en: '[Scheduled]',
};

export function buildScheduledSessionTitle(locale: CronNotificationLocale, jobName: string): string {
  return `${SCHEDULED_PREFIX[locale]} ${jobName}`;
}

const SCHEDULED_TITLE_PATTERN = new RegExp(
  `(?:${Object.values(SCHEDULED_PREFIX).map((p) => p.replace(/[[\]]/g, '\\$&')).join('|')})\\s*(.+)$`,
);

/** 从 host 通知标题里取任务名；兼容两种前缀与「任务完成 - 」之类外壳，名称本身可含方括号。 */
export function parseScheduledJobName(title: string): string | undefined {
  const name = title.match(SCHEDULED_TITLE_PATTERN)?.[1]?.trim();
  return name || undefined;
}
