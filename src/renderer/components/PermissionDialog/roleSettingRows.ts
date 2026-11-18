// set_role_proactivity 审批卡正文：由宿主给的结构化 before/after 按界面语言拼「旧 -> 新」行。
// 缺结构化数据（CLI / 停车收件箱 / 旧事件）时返回 undefined，调用方退回宿主的 preview.summary。

import type { Translations } from '../../hooks/useI18n';
import type { Language } from '../../i18n';
import { formatCronExpressionLabel } from '@shared/cronHumanize';
import { localizeBuiltinRole } from '@shared/localizeBuiltinRole';

interface RoleSettingSnapshot {
  level: string;
  cadence: string | null;
  quietHours: { start: string; end: string } | null;
  topicsInclude: string[];
  topicsExclude: string[];
}

function readSnapshot(value: unknown): RoleSettingSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : []);
  const q = v.quietHours as Record<string, unknown> | null | undefined;
  if (typeof v.level !== 'string') return undefined;
  return {
    level: v.level,
    cadence: typeof v.cadence === 'string' && v.cadence ? v.cadence : null,
    quietHours: q && typeof q.start === 'string' && typeof q.end === 'string' ? { start: q.start, end: q.end } : null,
    topicsInclude: list(v.topicsInclude),
    topicsExclude: list(v.topicsExclude),
  };
}

export function describeRoleSettingChange(
  details: Record<string, unknown>,
  t: Translations,
  language: Language,
): string | undefined {
  const p = t.decisionCard.permission;
  const before = readSnapshot(details.before);
  const after = readSnapshot(details.after);
  const roleId = typeof details.roleId === 'string' ? details.roleId : '';
  if (!before || !after || !roleId) return undefined;

  const levelLabel = (level: string): string => (
    level === 'silent' ? p.roleSettingLevelSilent
      : level === 'daily' ? p.roleSettingLevelDaily
        : level === 'realtime' ? p.roleSettingLevelRealtime
          : level
  );
  // cadence 是 croner 6 段表达式（含秒位）；humanize 只认 5 段。
  const cadenceLabel = (cadence: string): string => {
    const fields = cadence.trim().split(/\s+/);
    const five = fields.length === 6 && fields[0] === '0' ? fields.slice(1).join(' ') : cadence;
    return formatCronExpressionLabel(five, undefined, language);
  };
  const frequency = (s: RoleSettingSnapshot): string => `${levelLabel(s.level)}${s.cadence ? p.roleSettingCadenceWrap.replace('{cadence}', () => cadenceLabel(s.cadence as string)) : ''}`;
  const quiet = (s: RoleSettingSnapshot): string => (
    s.quietHours ? p.roleSettingQuietRange.replace('{start}', s.quietHours.start).replace('{end}', s.quietHours.end) : p.roleSettingNotSet
  );
  const roleName = localizeBuiltinRole(roleId, { name: roleId }, language).name;

  const row = (label: string, value: string): string => p.roleSettingLabelValue.replace('{label}', label).replace('{value}', () => value);

  const lines: string[] = [p.roleSettingHeader.replace('{role}', () => roleName)];
  if (before.level !== after.level || before.cadence !== after.cadence) {
    lines.push(row(p.roleSettingFrequency, `${frequency(before)} -> ${frequency(after)}`));
  }
  const topicDiff = (label: string, from: string[], to: string[]): void => {
    const added = to.filter((x) => !from.includes(x));
    const removed = from.filter((x) => !to.includes(x));
    if (added.length > 0) lines.push(row(label, `+ ${added.join(p.roleSettingListSeparator)}`));
    if (removed.length > 0) lines.push(row(label, `- ${removed.join(p.roleSettingListSeparator)}`));
  };
  topicDiff(p.roleSettingNever, before.topicsExclude, after.topicsExclude);
  topicDiff(p.roleSettingWant, before.topicsInclude, after.topicsInclude);
  if (before.quietHours?.start !== after.quietHours?.start || before.quietHours?.end !== after.quietHours?.end) {
    lines.push(row(p.roleSettingQuiet, `${quiet(before)} -> ${quiet(after)}`));
  } else {
    lines.push(row(p.roleSettingQuiet, p.roleSettingUnchanged));
  }
  return lines.join('\n');
}
