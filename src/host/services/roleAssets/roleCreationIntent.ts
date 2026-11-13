/**
 * Host-side direct-create intent check. The caller must pass the latest real
 * user-authored message; tool arguments are deliberately not part of this API.
 */
const DIRECT_CREATE_NEGATION = /(?:不要|别|不想|暂不|先不|不用|无需|不必|不是)/;
const DIRECT_CREATE_NEGATION_WINDOW = 4;

function hasNegatedDirectCreate(text: string): boolean {
  for (const match of text.matchAll(/直接(?:帮我)?(?:创建|新建|建立)/g)) {
    const precedingText = text.slice(
      Math.max(0, match.index - DIRECT_CREATE_NEGATION_WINDOW),
      match.index,
    );
    if (DIRECT_CREATE_NEGATION.test(precedingText)) return true;
  }
  return false;
}

export function shouldCreateRoleDirectly(userText: string): boolean {
  const text = userText.trim();
  if (!text) return false;
  if (hasNegatedDirectCreate(text)) return false;
  if (/(?:不要|别|不想|暂不|先不)(?:直接)?(?:创建|新建|建立)/.test(text)) return false;
  if (/(?:要不要|是否|能不能|该不该)(?:直接)?(?:创建|新建|建立)/.test(text)) return false;
  if (/直接(?:创建|新建|建立).{0,8}(?:还是|吗|？|\?)/.test(text)) return false;

  const explicitlySkipsConfirmation =
    /直接(?:帮我)?(?:创建|新建|建立)/.test(text)
    || /(?:不用|无需|不必|别)(?:再)?(?:问(?:我)?(?:问题)?|询问(?:我)?|确认(?:一下)?)/.test(text);
  if (explicitlySkipsConfirmation) return true;

  if (!/^\s*\/create-role(?:\s|$)/i.test(text)) return false;
  const givesName = /(?:名字|名称)\s*(?:叫|是|为|[:：])\s*[「『“"']?[^\s，。；;]{1,32}/.test(text);
  const givesDuties = /(?:职责|职能|任务|负责|帮我|主要(?:做|处理))\s*(?:是|为|[:：])?\s*.{2,}/.test(text);
  return givesName && givesDuties;
}

// ---------------------------------------------------------------------------
// Natural-language "create an expert" route (no /create-role typed).
// Deterministic host-side check; weak models do not reliably pick the Skill tool.
// ---------------------------------------------------------------------------
const ROLE_AUTHORING_SLASH_SEED = /^\s*\/(?:create-role|edit-role)(?:\s|$)/;
const NL_MAX_LENGTH = 300;
const NL_CREATE_ROLE =
  /^(?:(?:请你?|麻烦你?|帮我|给我|为我|我想|我要|直接)\s*)*(?:创建|新建|建立|招(?:一个|个|一位|位)|建(?:一个|个|一位))\s*(?:一个|个|一位|位|新的|新)?([^，。；,.;！!？?：:\n]{0,12}?)(专家(?:角色)?|助理(?:角色)?|角色)/;
const NL_WORK_ROLE_NAME = /(?:专家|助理|助手|管家|研究员|分析师|设计师|工程师|经理|总监|顾问|编辑|秘书|教练|客服)$/;
const NL_NON_EXPERT_ROLE_CONTEXT = /数据库|只读|权限|授权|授予|策略|信任关系|\b(?:postgres(?:ql)?|mysql|sqlite|sql|oracle|aws|iam|lambda|rbac)\b|(?:游戏|小说|故事|剧本)(?:中|里)(?:的)?/i;
const NL_NEGATION = /(?:不要|别|不想|暂不|先不|不用|无需|不必|不是|没必要|不需要)/;
const NL_QUESTION = /(?:要不要|是否|能不能|能否|该不该|可不可以|怎么样?|怎样|如何|什么是|吗)/;
const NL_EXISTING_ROLE_VERB = /(?:列出|查看|删除|移除|修改|编辑|更新|禁用|启用|有哪些|已有|现有|已经?创建|创建过|之前创建)/;

/** True for an affirmative "create / new / build an expert|role|assistant" request. */
function isNaturalLanguageCreateRoleRequest(userText: string): boolean {
  const text = userText.trim();
  if (!text || text.length > NL_MAX_LENGTH || text.startsWith('/')) return false;
  const match = NL_CREATE_ROLE.exec(text);
  if (!match) return false;
  const [, name, kind] = match;
  if (/(?:游戏|小说|故事|剧本)(?:中|里)(?:的)?/.test(name)) return false;
  const after = text.slice(match[0].length).trimStart();
  // The expert/assistant must be the requested object, not a modifier of an
  // artifact such as an assistant website or an expert introduction page.
  const namedRoleSuffix = kind === '角色' && !name && NL_WORK_ROLE_NAME.test(after);
  if (after && !/^[，。；,.;！!？?：:]|^(?:负责|帮我|职责|职能|任务)/.test(after) && !namedRoleSuffix) return false;
  // "角色" is overloaded. Named roles need a work identity; resource and
  // fictional-role contexts need an explicit expert/assistant designation.
  if (kind === '角色' && !/(?:专家|助理|助手)$/.test(name)) {
    if (name && !NL_WORK_ROLE_NAME.test(name.trim())) return false;
    if (NL_NON_EXPERT_ROLE_CONTEXT.test(text.split(/[。；;\n]/)[0])) return false;
  }
  const before = text.slice(0, match.index);
  if (NL_EXISTING_ROLE_VERB.test(before) || NL_EXISTING_ROLE_VERB.test(match[0])) return false;
  if (NL_NEGATION.test(text.slice(Math.max(0, match.index - DIRECT_CREATE_NEGATION_WINDOW), match.index))) return false;
  // Question forms are judged on the clause that holds the create verb.
  const clauseEnd = text.slice(match.index).search(/[。；;\n]/);
  const clause = clauseEnd < 0 ? text.slice(Math.max(0, match.index - 4)) : text.slice(Math.max(0, match.index - 4), match.index + clauseEnd);
  return !NL_QUESTION.test(clause);
}

type RoleAuthoringSeed =
  | { kind: 'slash'; skillName: 'create-role' | 'edit-role'; text: string }
  | { kind: 'natural-language'; skillName: 'create-role'; text: string };

/**
 * Recognise a role-authoring seed: an explicit /create-role|/edit-role, or a
 * natural-language create-role request. `text` is what the skill resolver
 * should see (natural language is rewritten as `/create-role <original>`).
 */
export function matchRoleAuthoringSeed(userText: string): RoleAuthoringSeed | null {
  const text = userText.trim();
  if (ROLE_AUTHORING_SLASH_SEED.test(text)) {
    return { kind: 'slash', skillName: text.startsWith('/edit-role') ? 'edit-role' : 'create-role', text };
  }
  if (isNaturalLanguageCreateRoleRequest(text)) {
    return { kind: 'natural-language', skillName: 'create-role', text: `/create-role ${text}` };
  }
  return null;
}
