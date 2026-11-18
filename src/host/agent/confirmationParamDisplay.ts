// ============================================================================
// 审批卡「操作详情」通用参数行的人话化：键名本地化、内部开关隐藏、上传/临时路径只留文件名。
// 仅用于展示；真实执行仍使用原始参数。
// ============================================================================
import os from 'os';
import path from 'path';
// eslint-disable-next-line no-restricted-imports -- 复用聊天上传目录判定的单一真源（纯路径判断，不执行工具）
import { isChatUploadPath } from '../tools/file/pathUtils';

// 对用户无意义的内部开关/样式参数（取值是内部枚举，如 theme: professional），无论取值类型一律不展示。
const INTERNAL_SWITCH_KEYS = new Set(['dry_run', 'dryRun', 'debug', 'verbose', 'theme']);

const PARAM_LABELS: Record<string, { zh: string; en: string }> = {
  sheet_name: { zh: '工作表', en: 'Sheet' },
  output_path: { zh: '保存到', en: 'Save to' },
  file_path: { zh: '文件', en: 'File' },
  path: { zh: '文件', en: 'File' },
  title: { zh: '标题', en: 'Title' },
};

const TEMP_DIR_PREFIXES = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];

const PATH_KEYS = ['output_path', 'file_path', 'path'];

/**
 * 预览取 3 行名额时的排序：保存位置/文件路径优先，其次有标签的键，再是未知键，
 * JSON 形态的载荷（表格 data、http body）垫底——名额有空时仍展示，不会被整段丢掉；同级保持原顺序。
 */
export function orderParamEntries<T>(entries: Array<[string, T]>): Array<[string, T]> {
  const rank = ([key, value]: [string, T]): number => {
    if (typeof value === 'string' && isStructuredDataText(value.trim())) return 3;
    return PATH_KEYS.includes(key) ? 0 : key in PARAM_LABELS ? 1 : 2;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(item => item.entry);
}

export function isInternalSwitchParam(key: string): boolean {
  return INTERNAL_SWITCH_KEYS.has(key);
}

export function localizeParamKey(key: string, locale: 'zh' | 'en'): string {
  return PARAM_LABELS[key]?.[locale] ?? key;
}

function isUnder(normalized: string, dir: string): boolean {
  const base = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  return !!base && (normalized === base || normalized.startsWith(`${base}/`));
}

/**
 * 路径值展示：工作区内 → 相对形式；上传目录 / 系统临时目录 → 仅文件名；其余原样（不隐藏真实目标）。
 * 非绝对路径的值原样返回。
 */
export function displayPathValue(
  value: string,
  relativize: (text: string) => string,
): string {
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(value) || value.includes('\n')) return value;
  const relative = relativize(value);
  if (relative !== value) return relative;
  const normalized = value.replace(/\\/g, '/');
  const tempDirs = [...TEMP_DIR_PREFIXES, os.tmpdir()];
  if (isChatUploadPath(value) || tempDirs.some(dir => isUnder(normalized, dir))) {
    return path.posix.basename(normalized) || value;
  }
  return value;
}

/** 以 JSON 数组/对象形式塞进字符串的载荷（如表格 data）不是人话，也会挤占 3 行预览名额。 */
export function isStructuredDataText(value: string): boolean {
  return /^[[{]/.test(value) && /[\]}]$/.test(value);
}
