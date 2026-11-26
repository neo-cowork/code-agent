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

const BUILTIN_PROFESSION_ZH: Readonly<Record<string, string>> = {
  资深产品经理: '牧之',
  竞品与市场情报分析师: '溯真',
  内容主理人: '青禾',
  项目复盘顾问: '明镜',
  合同审查顾问: '持衡',
  会议纪要与行政助理: '记言',
  文献综述研究员: '万卷',
  增长分析师: '岚析',
  视觉设计师: '映川',
};

/** For a stored memberName, which is the raw name or the raw profession of the member (render-time only). */
export function localizeStoredMemberName(stored: string, lang: string): string {
  if (lang !== 'en') return stored;
  if (Object.hasOwn(BUILTIN_PROFESSION_ZH, stored)) {
    return BUILTIN_ROLE_EN[BUILTIN_PROFESSION_ZH[stored]].profession;
  }
  return localizeBuiltinRole(stored, { name: stored }, lang).name;
}
