import { ROLE_PROACTIVITY } from './constants/memory';
import { localizeBuiltinRole } from './localizeBuiltinRole';

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

const WAKE_WORD_EN = 'Proactive check';
const WAKE_TITLE_PATTERN = new RegExp(`^(.+?) · ${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}( \\d{2}-\\d{2} \\d{2}:\\d{2})?$`);
const WAKE_LAST_WORK_PATTERN = new RegExp(`^(\\S+) ${ROLE_PROACTIVITY.WAKE_SESSION_TITLE_PREFIX}$`);

/**
 * Role wake titles (`<roleId> · <wake word> [MM-DD HH:MM]`) and the role card last-work line
 * (`<date> <wake word>`) are stored with the Chinese wake word that history filters match on.
 * Display only: the stored value and the constant never change; zh returns the input as is.
 */
export function localizeRoleWakeTitle(title: string, language: 'zh' | 'en'): string {
  if (language !== 'en') return title;
  const wake = WAKE_TITLE_PATTERN.exec(title);
  if (wake) {
    const name = localizeBuiltinRole(wake[1], { name: wake[1] }, 'en').name;
    return `${name} · ${WAKE_WORD_EN}${wake[2] ?? ''}`;
  }
  const lastWork = WAKE_LAST_WORK_PATTERN.exec(title);
  return lastWork ? `${lastWork[1]} ${WAKE_WORD_EN}` : title;
}

export function localizeCronSessionTitle(title: string, language: 'zh' | 'en', labels = cronSessionTitlePrefixes[language]): string {
  const parts = parseCronSessionTitle(title);
  return parts ? `${labels[parts.kind]}${parts.name ? ` ${parts.name}` : ''}` : localizeRoleWakeTitle(title, language);
}

export function formatStoredCronSessionTitle(name: string, kind: 'schedule' | 'heartbeat'): string {
  const cleanName = parseCronSessionTitle(name)?.name.trim() || name;
  return `${cronSessionTitlePrefixes.en[kind]} ${cleanName}`;
}
