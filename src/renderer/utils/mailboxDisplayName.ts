// Mail 连接器返回的邮箱名 → 界面显示名。只换显示，保存的值始终是原名。
// 做法同 Thunderbird / Roundcube：名字正好是常见默认系统邮箱才翻译，其余原样。
import type { CronHumanLang } from '@shared/cronHumanize';
import { mailboxNamesZh } from '../i18n/mailboxNames';

type SystemMailbox = Exclude<keyof typeof mailboxNamesZh, 'withOriginal'>;

const SYSTEM_MAILBOX_BY_NAME = new Map<string, SystemMailbox>([
  ['inbox', 'inbox'],
  ['sent', 'sent'],
  ['sent messages', 'sent'],
  ['sent mail', 'sent'],
  ['sent items', 'sent'],
  ['drafts', 'drafts'],
  ['draft', 'drafts'],
  ['trash', 'trash'],
  ['deleted messages', 'trash'],
  ['deleted', 'trash'],
  ['deleted items', 'trash'],
  ['bin', 'trash'],
  ['junk', 'junk'],
  ['junk mail', 'junk'],
  ['junk email', 'junk'],
  ['junk e-mail', 'junk'],
  ['spam', 'junk'],
  ['bulk', 'junk'],
  ['bulk mail', 'junk'],
  ['archive', 'archive'],
  ['archives', 'archive'],
  ['all mail', 'archive'],
  ['outbox', 'outbox'],
]);

const GMAIL_PREFIX = /^\[(?:gmail|google mail)\]\//;

export function mailboxDisplayName(name: string, lang: CronHumanLang): string {
  if (lang !== 'zh') return name;
  const system = SYSTEM_MAILBOX_BY_NAME.get(name.trim().toLowerCase().replace(GMAIL_PREFIX, ''));
  return system ? mailboxNamesZh[system] : name;
}

/** 下拉用：译名和列表里另一项的显示名相同时，译出的那项带上原名，保证每项分得清。 */
export function mailboxOptionLabels(names: readonly string[], lang: CronHumanLang): string[] {
  const labels = names.map((name) => mailboxDisplayName(name, lang));
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return labels.map((label, index) => {
    const name = names[index];
    if (label === name || (counts.get(label) ?? 0) < 2) return label;
    return mailboxNamesZh.withOriginal.replace('{label}', label).replace('{name}', name.trim());
  });
}
