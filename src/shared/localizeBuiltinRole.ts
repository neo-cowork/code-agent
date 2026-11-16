// Presentation only: role ids, @-command tokens and persisted text keep the original names.
// English UI shows built-in experts by pinyin nickname + English profession; user-created roles are untouched.
const BUILTIN_ROLE_EN: Readonly<Record<string, { name: string; profession: string }>> = {
  数据分析师: { name: 'Zhiwei', profession: 'Data Analyst' },
  牧之: { name: 'Muzhi', profession: 'Senior Product Manager' },
  溯真: { name: 'Suzhen', profession: 'Competitive & Market Intelligence Analyst' },
  青禾: { name: 'Qinghe', profession: 'Content Lead' },
  明镜: { name: 'Mingjing', profession: 'Project Retrospective Advisor' },
  持衡: { name: 'Chiheng', profession: 'Contract Review Advisor' },
  记言: { name: 'Jiyan', profession: 'Meeting Notes & Admin Assistant' },
  万卷: { name: 'Wanjuan', profession: 'Literature Review Researcher' },
  岚析: { name: 'Lanxi', profession: 'Growth Analyst' },
  映川: { name: 'Yingchuan', profession: 'Visual Designer' },
  研究员: { name: 'Researcher', profession: 'Researcher' },
};

// Some surfaces only hold the zh display name (agent.name, memberName, speaker labels), not the roleId.
const BUILTIN_ROLE_ALIAS: Readonly<Record<string, string>> = { 知微: '数据分析师' };

export interface RoleNameParts {
  name: string;
  profession?: string;
}

export function localizeBuiltinRole(roleId: string, parts: RoleNameParts, lang: string): RoleNameParts {
  if (lang !== 'en') return parts;
  const key = Object.hasOwn(BUILTIN_ROLE_ALIAS, roleId) ? BUILTIN_ROLE_ALIAS[roleId] : roleId;
  if (!Object.hasOwn(BUILTIN_ROLE_EN, key)) return parts;
  const en = BUILTIN_ROLE_EN[key];
  return { name: en.name, profession: parts.profession ? en.profession : parts.profession };
}
