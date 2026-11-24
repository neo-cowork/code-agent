import { zh, type Translations } from '../../../../i18n/zh';
import { interpolatePlural } from '../../../../i18n/interpolate';

export interface MentionRoutingAgent {
  id: string;
  name: string;
  /** 显式 mention 触发 token（如 Neo 工作卡固定 '@neo'）；缺省按 name→id 归一。 */
  mentionToken?: string;
}

export interface ParsedAgentMentionRouting {
  content: string;
  targetAgentIds: string[];
}

export interface AgentMentionAutocompleteResult {
  query: string;
  matches: MentionRoutingAgent[];
}

// mention token 允许的字符：ASCII 字母数字 + ._- + 汉字（Script=Han，角色名可为中文）。
// 集中一处定义，下方 normalize/解析/补全的正则共用同一字符类，防止漂移。
const MENTION_TOKEN_CHARS = 'A-Za-z0-9._\\-\\p{Script=Han}';
const NON_MENTION_TOKEN_CHARS_RE = new RegExp(`[^${MENTION_TOKEN_CHARS}]+`, 'gu');
const LEADING_MENTION_PREFIX_RE = new RegExp(`^(?:@[${MENTION_TOKEN_CHARS}]+\\s+)*$`, 'u');
const TRAILING_MENTION_QUERY_RE = new RegExp(`(?:^|\\s)@([${MENTION_TOKEN_CHARS}]*)$`, 'u');
const LEADING_MENTION_TOKEN_RE = new RegExp(`^@([${MENTION_TOKEN_CHARS}]+)(?=\\s|$)`, 'u');

function isReservedNeoMention(value: string): boolean {
  return normalizeMentionToken(value) === 'neo';
}

function normalizeMentionToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(NON_MENTION_TOKEN_CHARS_RE, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildAgentAliasSet(agent: MentionRoutingAgent): Set<string> {
  const aliases = new Set<string>();
  const addAlias = (value: string) => {
    const normalized = normalizeMentionToken(value);
    if (!normalized) return;
    aliases.add(normalized);
    aliases.add(normalized.replace(/-/g, ''));
  };

  addAlias(agent.id);
  addAlias(agent.name);
  addAlias(agent.mentionToken ?? '');
  return aliases;
}

function resolveAgentByToken(
  token: string,
  agents: MentionRoutingAgent[],
): MentionRoutingAgent | null {
  const normalizedToken = normalizeMentionToken(token);
  if (!normalizedToken) return null;

  for (const agent of agents) {
    const aliases = buildAgentAliasSet(agent);
    if (aliases.has(normalizedToken)) {
      return agent;
    }
  }

  return null;
}

function isLeadingMentionPrefix(prefix: string): boolean {
  return LEADING_MENTION_PREFIX_RE.test(prefix);
}

function getTrailingMentionQuery(value: string): string | null {
  const trimmedStart = value.replace(/^\s+/, '');
  if (!trimmedStart.startsWith('@')) {
    return null;
  }

  const trailingMentionMatch = trimmedStart.match(TRAILING_MENTION_QUERY_RE);
  if (!trailingMentionMatch) {
    return null;
  }

  const mentionText = trailingMentionMatch[0].trimStart();
  const prefix = trimmedStart.slice(0, trimmedStart.length - mentionText.length);
  if (!isLeadingMentionPrefix(prefix)) {
    return null;
  }

  return trailingMentionMatch[1] || '';
}

export function getPreferredAgentMentionToken(agent: MentionRoutingAgent): string {
  return normalizeMentionToken(agent.mentionToken ?? '')
    || normalizeMentionToken(agent.name)
    || normalizeMentionToken(agent.id);
}

function formatAgentList(agents: MentionRoutingAgent[], joiner: string): string {
  return agents.map((agent) => agent.name).join(joiner);
}

export function buildDirectRoutingHint(
  selectedAgents: MentionRoutingAgent[],
  availableAgents: MentionRoutingAgent[],
  t: Translations = zh,
): string {
  const copy = t.agentMentionRouting;
  if (selectedAgents.length > 0) {
    if (selectedAgents.length === 1) {
      const target = selectedAgents[0]!;
      return copy.directHintSingle
        .replace('{name}', target.name)
        .replace('{token}', getPreferredAgentMentionToken(target));
    }
    return copy.directHintMulti.replace('{names}', formatAgentList(selectedAgents, copy.listJoiner));
  }

  const sampleAgent = availableAgents[0];
  if (sampleAgent) {
    return copy.directHintSample.replace('{token}', getPreferredAgentMentionToken(sampleAgent));
  }

  return copy.directHintEmpty;
}

export function buildDirectRoutingPlaceholder(
  selectedAgents: MentionRoutingAgent[],
  availableAgents: MentionRoutingAgent[],
  t: Translations = zh,
): string {
  const copy = t.agentMentionRouting;
  if (selectedAgents.length > 0) {
    if (selectedAgents.length === 1) {
      const target = selectedAgents[0]!;
      return copy.directPlaceholderSingle
        .replace('{name}', target.name)
        .replace('{token}', getPreferredAgentMentionToken(target));
    }
    return interpolatePlural(copy.directPlaceholderMulti, selectedAgents.length);
  }

  const sampleAgent = availableAgents[0];
  if (sampleAgent) {
    return copy.directPlaceholderSample.replace('{token}', getPreferredAgentMentionToken(sampleAgent));
  }

  return copy.directPlaceholderEmpty;
}

export function syncLeadingAgentMentions(
  value: string,
  selectedAgents: MentionRoutingAgent[],
  availableAgents: MentionRoutingAgent[],
): string {
  const parsed = parseLeadingAgentMentions(value, availableAgents);
  const content = parsed ? parsed.content : value.trim();

  if (selectedAgents.length === 0) {
    return content;
  }

  const mentionPrefix = selectedAgents
    .map((agent) => `@${getPreferredAgentMentionToken(agent)}`)
    .join(' ');

  return content ? `${mentionPrefix} ${content}` : `${mentionPrefix} `;
}

export function getLeadingAgentMentionAutocomplete(
  value: string,
  agents: MentionRoutingAgent[],
  _neoTopicCandidates?: MentionRoutingAgent[],
  _t: Translations = zh,
): AgentMentionAutocompleteResult | null {
  const query = getTrailingMentionQuery(value);
  if (query === null) {
    return null;
  }

  const normalizedQuery = normalizeMentionToken(query);
  const matches = agents.filter((agent) => {
    // @neo 已从 composer 入口移除（2026-07-29 拍板，工作卡改从 Neo 协同页发起），
    // swarm agent 命名为 neo 也不在直连候选里出现。
    if (isReservedNeoMention(agent.id) || isReservedNeoMention(agent.name) || isReservedNeoMention(agent.mentionToken ?? '')) {
      return false;
    }
    const aliases = buildAgentAliasSet(agent);
    if (!normalizedQuery) {
      return aliases.size > 0;
    }
    return Array.from(aliases).some((alias) => alias.startsWith(normalizedQuery));
  });

  if (matches.length === 0) {
    return null;
  }

  return {
    query,
    matches,
  };
}

export function applyAgentMentionSuggestion(
  value: string,
  agent: MentionRoutingAgent,
): string {
  const query = getTrailingMentionQuery(value);
  if (query === null) {
    return value;
  }

  const mentionText = `@${query}`;
  const replaceStart = value.length - mentionText.length;
  const nextMention = `@${getPreferredAgentMentionToken(agent)}`;
  return `${value.slice(0, replaceStart)}${nextMention} `;
}

export function parseLeadingAgentMentions(
  content: string,
  agents: MentionRoutingAgent[],
): ParsedAgentMentionRouting | null {
  const trimmedStart = content.replace(/^\s+/, '');
  if (!trimmedStart.startsWith('@')) {
    return null;
  }

  const resolvedAgents: MentionRoutingAgent[] = [];
  let cursor = 0;

  while (cursor < trimmedStart.length) {
    const mentionMatch = trimmedStart.slice(cursor).match(LEADING_MENTION_TOKEN_RE);
    if (!mentionMatch) break;
    if (isReservedNeoMention(mentionMatch[1])) break;

    const agent = resolveAgentByToken(mentionMatch[1], agents);
    if (!agent) {
      break;
    }

    resolvedAgents.push(agent);
    cursor += mentionMatch[0].length;

    const whitespaceMatch = trimmedStart.slice(cursor).match(/^\s+/);
    if (!whitespaceMatch) {
      break;
    }
    cursor += whitespaceMatch[0].length;
  }

  if (resolvedAgents.length === 0) {
    return null;
  }

  const targetAgentIds = Array.from(new Set(resolvedAgents.map((agent) => agent.id)));
  const strippedContent = trimmedStart.slice(cursor).trim();

  return {
    content: strippedContent,
    targetAgentIds,
  };
}

export function isLeadingAgentMentionInput(
  value: string,
  agents: MentionRoutingAgent[],
): boolean {
  return getLeadingAgentMentionAutocomplete(value, agents) !== null;
}
