import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES, RETIRED_BUILTIN_ROLE_VISUALS } from '../../../src/host/services/roleAssets/builtinRoles';
import { CATALOG_TEXT_EN } from '../../../src/renderer/i18n/catalogTextEn';
import {
  localizeCatalogObject,
  localizeMcpCatalog,
  localizeSkillCatalog,
  translateCatalogText,
} from '../../../src/renderer/utils/catalogText';
import { getBuiltinMcpCatalogPayload } from '../../../src/shared/constants/mcpCatalog';
import { getBuiltinSkillCatalogPayload } from '../../../src/shared/constants/skillCatalog';
import { MCP_CATEGORIES, RECOMMENDED_MCP_SERVERS } from '../../../src/shared/constants/mcpCatalog';
import {
  RECOMMENDED_REPOSITORIES,
  RECOMMENDED_SKILLS,
  SKILL_CATEGORIES,
  SKILL_ROLE_BUNDLES,
} from '../../../src/shared/constants/skillCatalog';
import { TEAM_RECIPES } from '../../../src/shared/constants/teamRecipeCatalog';

const HAN = /[㐀-䶿一-鿿豈-﫿]/u;

/** 各份内置目录里会显示到能力中心卡片上的字段（名称、说明、角标、标签、开场白、风险提示）。 */
function displayedCatalogStrings(): string[] {
  const out = new Set<string>();
  const add = (...values: Array<string | undefined>) => {
    for (const value of values) if (value && HAN.test(value)) out.add(value);
  };
  for (const category of [...SKILL_CATEGORIES, ...MCP_CATEGORIES]) add(category.label, category.description);
  for (const repo of RECOMMENDED_REPOSITORIES) add(repo.name, repo.description, repo.author);
  for (const bundle of SKILL_ROLE_BUNDLES) {
    add(bundle.name, bundle.description);
    for (const skill of bundle.skills) add(skill.displayName);
  }
  for (const skill of RECOMMENDED_SKILLS) add(skill.displayName, skill.description, skill.badge);
  for (const server of RECOMMENDED_MCP_SERVERS) {
    add(server.name, server.description, server.badge, server.riskNote, ...(server.requiredCredentials ?? []));
  }
  for (const role of BUILTIN_ROLES) {
    add(role.visual.displayName, role.visual.profession, ...role.visual.tags, ...role.visual.quickPrompts);
    add(/^description:\s*(.+)$/m.exec(role.agentMd)?.[1]);
  }
  for (const visual of Object.values(RETIRED_BUILTIN_ROLE_VISUALS)) {
    add(visual.displayName, visual.profession, ...visual.tags, ...visual.quickPrompts);
  }
  for (const recipe of TEAM_RECIPES) add(recipe.name, recipe.description, ...(recipe.tags ?? []), ...(recipe.quickPrompts ?? []));
  return [...out];
}

describe('能力中心目录数据跟随界面语言（FB-1301）', () => {
  it('内置目录里每一条会上屏的中文都有英文，且英文不含中文', () => {
    const strings = displayedCatalogStrings();
    expect(strings.length).toBeGreaterThan(250);
    const missing = strings.filter((text) => HAN.test(translateCatalogText(text, 'en')));
    expect(missing).toEqual([]);
  });

  it('英文表里的每一条译文本身都不含中文', () => {
    expect(Object.entries(CATALOG_TEXT_EN).filter(([, en]) => HAN.test(en) || !en.trim())).toEqual([]);
  });

  it('中文界面原样返回；表里没有的（用户自己的内容）两种语言都原样返回', () => {
    for (const text of displayedCatalogStrings()) expect(translateCatalogText(text, 'zh')).toBe(text);
    expect(translateCatalogText('我自己写的技能', 'en')).toBe('我自己写的技能');
    expect(translateCatalogText(undefined, 'en')).toBeUndefined();
    expect(translateCatalogText('文档办公', 'en')).toBe('Documents & office');
  });

  it('整份技能 / 连接器目录换成英文后，卡片字段不含中文；中文界面拿到的是同一个对象', () => {
    const skills = getBuiltinSkillCatalogPayload();
    const mcp = getBuiltinMcpCatalogPayload();
    expect(localizeSkillCatalog(skills, 'zh')).toBe(skills);
    expect(localizeMcpCatalog(mcp, 'zh')).toBe(mcp);

    const enSkills = localizeSkillCatalog(skills, 'en');
    const skillText = [
      ...enSkills.categories.flatMap((c) => [c.label, c.description]),
      ...enSkills.skills.flatMap((s) => [s.displayName, s.description, s.badge ?? '']),
      ...enSkills.bundles.flatMap((b) => [b.name, b.description, ...b.skills.map((s) => s.displayName)]),
      ...enSkills.repositories.flatMap((r) => [r.name, r.description ?? '', r.author ?? '']),
    ];
    expect(skillText.filter((text) => HAN.test(text))).toEqual([]);
    expect(enSkills.skills.map((s) => s.name)).toEqual(skills.skills.map((s) => s.name));

    const enMcp = localizeMcpCatalog(mcp, 'en');
    const mcpText = [
      ...enMcp.categories.flatMap((c) => [c.label, c.description]),
      ...enMcp.servers.flatMap((s) => [s.name ?? '', s.description, s.badge ?? '', s.riskNote ?? '', ...(s.requiredCredentials ?? [])]),
    ];
    expect(mcpText.filter((text) => HAN.test(text))).toEqual([]);
    expect(enMcp.servers.map((s) => s.id)).toEqual(mcp.servers.map((s) => s.id));
  });

  it('专家与专家团队：上屏文字换成英文，roleId 这类身份字段和给模型的模板一个字不动', () => {
    const roles = BUILTIN_ROLES.map((role) => ({ roleId: role.id, ...role.visual }));
    const enRoles = localizeCatalogObject(roles, 'en');
    expect(enRoles.map((role) => role.roleId)).toEqual(BUILTIN_ROLES.map((role) => role.id));
    for (const role of enRoles) {
      for (const text of [role.displayName, role.profession, ...role.tags, ...role.quickPrompts]) expect(text).not.toMatch(HAN);
    }
    const enRecipes = localizeCatalogObject(TEAM_RECIPES, 'en');
    enRecipes.forEach((recipe, index) => {
      expect(recipe.id).toBe(TEAM_RECIPES[index].id);
      expect(recipe.lead).toEqual(TEAM_RECIPES[index].lead);
      expect(recipe.members).toEqual(TEAM_RECIPES[index].members);
      for (const text of [recipe.name, recipe.description, ...(recipe.tags ?? []), ...(recipe.quickPrompts ?? [])]) {
        expect(text).not.toMatch(HAN);
      }
    });
    expect(localizeCatalogObject(TEAM_RECIPES, 'zh')).toBe(TEAM_RECIPES);
  });
});
