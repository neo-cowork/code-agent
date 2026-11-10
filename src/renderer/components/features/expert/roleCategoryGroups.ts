import type { RolePanelEntry } from '@shared/contract/roleAssets';
import type { SkillCategory } from '@shared/contract/skillRepository';
import { SKILL_CATEGORIES } from '@shared/constants/skillCatalog';

const UNCATEGORIZED_KEY = '__uncategorized__';

export interface RoleCategoryGroup {
  /** 分类 key：SkillCategory 或 UNCATEGORIZED_KEY */
  key: string;
  /** 分组显示名 */
  label: string;
  entries: RolePanelEntry[];
}

export interface RoleCategoryLabels {
  categories: Record<SkillCategory, string>;
  uncategorized: string;
}

/** 取分类显示名；未知 category 返回 undefined */
function categoryLabel(category: SkillCategory, labels: RoleCategoryLabels): string | undefined {
  return labels.categories[category];
}

function resolveCategoryDisplayLabel(entry: RolePanelEntry, labels: RoleCategoryLabels): string {
  if (entry.category) {
    const label = categoryLabel(entry.category, labels);
    if (label) return label;
  }
  return labels.uncategorized;
}

/**
 * 专家搜索过滤（纯函数）：按去首尾空白、大小写不敏感子串匹配：
 * displayName || roleId、profession、description、tags、分类显示名。
 */
export function matchesRoleSearch(entry: RolePanelEntry, query: string, labels: RoleCategoryLabels): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  const fields: Array<string | undefined> = [
    entry.displayName || entry.roleId,
    entry.profession,
    entry.description,
    ...(entry.tags ?? []),
    resolveCategoryDisplayLabel(entry, labels),
  ];
  return fields.some((field) => field?.toLocaleLowerCase().includes(normalized) ?? false);
}

/**
 * 按产物分类对角色分组（纯函数，供 UI + 单测）。
 * - 顺序跟随 SKILL_CATEGORIES，空分类不出现
 * - 无 category（用户自建角色）统一归入末尾"其他"组
 */
export function groupRolesByCategory(entries: RolePanelEntry[], labels: RoleCategoryLabels): RoleCategoryGroup[] {
  const groups: RoleCategoryGroup[] = [];
  for (const meta of SKILL_CATEGORIES) {
    const inCategory = entries.filter((e) => e.category === meta.id);
    if (inCategory.length > 0) {
      groups.push({ key: meta.id, label: labels.categories[meta.id], entries: inCategory });
    }
  }
  const uncategorized = entries.filter((e) => !e.category || !categoryLabel(e.category, labels));
  if (uncategorized.length > 0) {
    groups.push({ key: UNCATEGORIZED_KEY, label: labels.uncategorized, entries: uncategorized });
  }
  return groups;
}
