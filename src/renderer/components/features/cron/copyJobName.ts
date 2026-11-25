// ============================================================================
// copyJobName —— 「按新位置复制」草稿任务名的自动位置后缀。
// 后缀词只从 cronCenter zh/en 文案表取，不在业务代码重写「本地/云端/Local/Cloud」
// 字面量：剥旧后缀要认全四种（副本可能是在另一种语言下保存的），写新后缀用当前
// 界面语言。位置后缀只出现在「复制到新位置」草稿（CronJobEditor copySource 分支），
// 别处不拼。
// ============================================================================

import type { CronRunsOn } from '@shared/contract';
import { cronCenterEn, cronCenterZh } from '../../../i18n/cronCenter';

type LocationWords = Pick<typeof cronCenterZh.cronCenter, 'locationLocal' | 'locationCloud'>;

const LOCATION_WORDS = [
  cronCenterZh.cronCenter.locationLocal,
  cronCenterZh.cronCenter.locationCloud,
  cronCenterEn.cronCenter.locationLocal,
  cronCenterEn.cronCenter.locationCloud,
];

const escapeRegExp = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TRAILING_LOCATION_SUFFIX_RE = new RegExp(
  ` \\((?:${LOCATION_WORDS.map(escapeRegExp).join('|')})\\)$`,
);

/**
 * 剥掉名字末尾的一个「 (<位置词>)」。没有该后缀、或末尾括号里不是位置词
 * （如「X (周报)」）时原样返回；只剥一个，不连锁剥。
 */
export function stripLocationSuffix(name: string): string {
  return name.replace(TRAILING_LOCATION_SUFFIX_RE, '');
}

/** 基名 + 当前语言的「 (本地)」/「 (云端)」，后缀词永远跟着给定的 runsOn。 */
export function withLocationSuffix(base: string, runsOn: CronRunsOn, cc: LocationWords): string {
  return `${base} (${runsOn === 'local' ? cc.locationLocal : cc.locationCloud})`;
}
