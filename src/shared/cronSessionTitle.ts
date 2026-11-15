/** Stored cron titles remain canonical English; presentation follows the current locale. */
export const cronSessionTitlePrefixes = {
  zh: { schedule: '[定时]', heartbeat: '[心跳]' },
  en: { schedule: '[Schedule]', heartbeat: '[Heartbeat]' },
};

const prefixes = [
  ...Object.values(cronSessionTitlePrefixes.zh),
  ...Object.values(cronSessionTitlePrefixes.en),
  '[Cron]',
];
const prefixPattern = new RegExp(`^(${prefixes.map((prefix) => prefix.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('|')})\\s*`, 'i');

export function parseCronSessionTitle(title: string): {
  prefix: string; name: string; kind: 'schedule' | 'heartbeat';
} | null {
  const match = prefixPattern.exec(title);
  if (!match) return null;
  return {
    prefix: match[1],
    name: title.slice(match[0].length),
    kind: [cronSessionTitlePrefixes.en.heartbeat, cronSessionTitlePrefixes.zh.heartbeat]
      .some((prefix) => prefix.toLowerCase() === match[1].toLowerCase()) ? 'heartbeat' : 'schedule',
  };
}

export function localizeCronSessionTitle(title: string, language: 'zh' | 'en', labels = cronSessionTitlePrefixes[language]): string {
  const parts = parseCronSessionTitle(title);
  return parts ? `${labels[parts.kind]}${parts.name ? ` ${parts.name}` : ''}` : title;
}

export function formatStoredCronSessionTitle(name: string, kind: 'schedule' | 'heartbeat'): string {
  const cleanName = parseCronSessionTitle(name)?.name.trim() || name;
  return `${cronSessionTitlePrefixes.en[kind]} ${cleanName}`;
}
