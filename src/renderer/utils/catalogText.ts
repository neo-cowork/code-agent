import type { McpCatalogPayload } from '@shared/contract/mcpCatalog';
import type { SkillCatalogPayload } from '@shared/contract/skillRepository';
import type { Language } from '../i18n';
import { CATALOG_TEXT_EN } from '../i18n/catalogTextEn';

/**
 * 能力中心目录数据（内置专家、技能、连接器、插件的名称和说明）的唯一显示出口。
 * 中文界面原样返回；英文界面按中文原句查 CATALOG_TEXT_EN，查不到的原样返回
 * （用户自己装的技能、自己起的名字不在表里，本来就该显示它自己的写法）。
 */
export function translateCatalogText(text: string, language: Language): string;
export function translateCatalogText(text: string | undefined, language: Language): string | undefined;
export function translateCatalogText(text: string | undefined, language: Language): string | undefined {
  if (language !== 'en' || !text) return text;
  return CATALOG_TEXT_EN.get(text) ?? text;
}

/** 连接器目录（内置或云端下发的整份 payload）：把会上屏的字段按语言换好，其余字段原样。 */
export function localizeMcpCatalog(payload: McpCatalogPayload, language: Language): McpCatalogPayload {
  if (language !== 'en') return payload;
  const tc = (text: string | undefined) => translateCatalogText(text, language);
  return {
    ...payload,
    categories: payload.categories.map((category) => ({
      ...category,
      label: tc(category.label) ?? category.label,
      description: tc(category.description) ?? category.description,
    })),
    servers: payload.servers.map((server) => ({
      ...server,
      ...(server.name ? { name: tc(server.name) } : {}),
      description: tc(server.description) ?? server.description,
      ...(server.badge ? { badge: tc(server.badge) } : {}),
      ...(server.riskNote ? { riskNote: tc(server.riskNote) } : {}),
      ...(server.requiredCredentials
        ? { requiredCredentials: server.requiredCredentials.map((item) => tc(item) ?? item) }
        : {}),
    })),
  };
}

/** 技能目录（分类 / 推荐技能 / 场景包 / 来源仓库）：同上。 */
export function localizeSkillCatalog(payload: SkillCatalogPayload, language: Language): SkillCatalogPayload {
  if (language !== 'en') return payload;
  const tc = (text: string | undefined) => translateCatalogText(text, language);
  return {
    ...payload,
    categories: payload.categories.map((category) => ({
      ...category,
      label: tc(category.label) ?? category.label,
      description: tc(category.description) ?? category.description,
    })),
    skills: payload.skills.map((skill) => ({
      ...skill,
      displayName: tc(skill.displayName) ?? skill.displayName,
      description: tc(skill.description) ?? skill.description,
      ...(skill.badge ? { badge: tc(skill.badge) } : {}),
    })),
    bundles: payload.bundles.map((bundle) => ({
      ...bundle,
      name: tc(bundle.name) ?? bundle.name,
      description: tc(bundle.description) ?? bundle.description,
      skills: bundle.skills.map((skill) => ({ ...skill, displayName: tc(skill.displayName) ?? skill.displayName })),
    })),
    repositories: payload.repositories.map((repo) => ({
      ...repo,
      name: tc(repo.name) ?? repo.name,
      ...(repo.description ? { description: tc(repo.description) } : {}),
      ...(repo.author ? { author: tc(repo.author) } : {}),
    })),
  };
}

/** 身份类字段：值是 id 或发给模型的模板，绝不能翻（专家的 roleId 本身就是中文花名）。 */
const CATALOG_IDENTITY_KEYS = new Set(['id', 'roleId', 'packId', 'icon', 'category', 'briefTemplate', 'taskTemplate']);

/**
 * 专家 / 专家团队 / 角色包这类结构各异的目录对象：把里面会上屏的字符串
 * （花名、职业、说明、标签、开场白）按语言换好，身份类字段和非字符串原样保留。
 */
export function localizeCatalogObject<T>(value: T, language: Language): T {
  if (language !== 'en') return value;
  if (typeof value === 'string') return translateCatalogText(value, language) as T;
  if (Array.isArray(value)) return (value as unknown[]).map((item) => localizeCatalogObject(item, language)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        CATALOG_IDENTITY_KEYS.has(key) ? item : localizeCatalogObject(item, language),
      ]),
    ) as T;
  }
  return value;
}
