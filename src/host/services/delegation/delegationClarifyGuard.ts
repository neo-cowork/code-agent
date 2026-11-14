// ============================================================================
// delegationClarifyGuard — deterministic "ask instead of bind" guard
// (ADR-072 D2/D3, N-DELEGATE-SESSION-K2-FU3-FU1)
// ============================================================================
// Pure function, no model call. The model only suggests a delegation; this guard
// looks at the user's latest message and the candidate display names and decides
// whether the suggestion may continue to the admission gates ('proceed') or must
// turn into a clickable question ('clarify').
//
// Every rule fires on POSITIVE evidence of a wrong/unsafe binding (the user named
// a different session, named one that does not exist, asked for a new session
// without saying so, gave no task content). Missing evidence alone never fires:
// "that one / the thing we just discussed" stays a legitimate anchor resolved by
// the conversation, so clear requests are never turned into questions.
// ============================================================================

export type ClarifyGuardRule =
  | 'create_new_without_new_intent'
  | 'named_target_absent'
  | 'named_other_candidate'
  | 'ambiguous_reference'
  | 'vague_task_text';

export interface ClarifyGuardCandidate {
  shortName: string;
  workspaceName: string;
}

export interface ClarifyGuardInput {
  action: 'delegate_existing' | 'create_new';
  /** Eligible candidates, display fields only (the projection's model-visible part). */
  candidates: ReadonlyArray<ClarifyGuardCandidate>;
  /** delegate_existing: index of the resolved candidate in `candidates`; null = unresolved. */
  chosenIndex: number | null;
  /** The user's latest message. null = not reachable → message-based rules are skipped. */
  userMessage: string | null;
}

export type ClarifyGuardVerdict =
  | { kind: 'proceed' }
  | {
      kind: 'clarify';
      rule: ClarifyGuardRule;
      candidateNames: string[];
      reason: 'unclear_target' | 'non_single_answer';
      message: string;
    };

const MAX_QUESTION_CANDIDATES = 8;
// A spoken full title outranks every partial signal, so it can never be tied by partial matches.
const FULL_TITLE_SCORE = 1000;

// Rule 1 evidence: the user explicitly asks for a brand-new session/task. "那个新开的会话"
// (a definite, already-existing session) deliberately does not match.
const NEW_INTENT_PATTERNS: ReadonlyArray<RegExp> = [
  /新(?:开|建|起|立)(?:了)?(?:一个|个|一摊)?(?:新)?(?:会话|对话|session|任务|项目)/i,
  /(?:开|建|起|立|单开)(?:个|一个|一摊)(?:全?新)?(?:的)?\s*(?:fresh\s*(?:的)?\s*)?(?:会话|对话|session|chat)/i,
  /单开|另起/,
  /(?:全新|新)的?\s*(?:会话|对话|session|项目|任务)/i,
  /从零|重新开始|独立项目/,
  /\b(?:new|fresh|brand[- ]new|separate)\s+(?:session|chat|conversation|task)\b/i,
  /\b(?:spin up|create a|start a|open a)\b/i,
  /\bfrom scratch\b/i,
];

// Rule 4 evidence: the message itself says "something / whatever / assign me a job" —
// there is no task to deliver, whoever the target is.
const VAGUE_MARKER = /排个?活|派点活|给点活|随便(?:派|发|给|排)|\b(?:something|whatever|any work|some work|some task)\b/gi;
const VAGUE_MAX_UNITS = 6;
// Anaphora means the content lives in the conversation ("this", "last time", "continue").
const ANAPHOR = /这个|这条|这事|这件|那个|那件|那事|刚才|刚刚|上次|上回|同上|照旧|继续|接着|再|也|一起|\b(?:it|this|that|them|same|again|continue|previous|last)\b/i;
const FILLER = /派给|发给|交给|转给|投给|安排|委托|派|发|交|给|投|让|把|请|帮|我|它|他|她|们|吧|啊|呀|去|一下|下|个|条|那|这|的|了|会话|对话|\b(?:send|delegate|assign|hand|over|ask|have|please|to|the|a|an|session|chat|it)\b|[\s,.;:!?，。；：！？、「」"'“”()（）-]/gi;

// 「<name>」会话 — the user names the target explicitly in quotes. (An English "the <word> session"
// is NOT used: the word may be a translation of a Chinese title, so it is not positive evidence.)
const QUOTED_TARGET = /[「“"]([^」”"]{1,40})[」”"]\s*(?:那个|这个|这条)?\s*(?:会话|对话|session|chat)/gi;
// 「投进/交给/发给/派给 X 会话」: unquoted explicit target. Pronoun-like or generic X is not a name.
const UNQUOTED_TARGET = /(?:投进|投给|投到|交给|发给|派给|转给)\s*([^，。,.;；\s「」的]{2,12}?)\s*(?:那个|这个)?会话/g;
// 「找个会话 / find a session」: the user asks Neo to pick a chat — no target was named, so a bound
// delegate_existing is a guess.
const INDEFINITE_TARGET = /(?:找个|找一个|挑个|选个)\s*(?:合适的?\s*)?(?:会话|对话)|\bfind\s+(?:me\s+)?(?:a|an|any)\s+(?:\w+\s+)?(?:session|chat)\b/i;
const GENERIC_TARGET = /^(?:这个|那个|另一个|另外一个|其他|其它|别的|新的?|新开的?|现有|既有|已有|旧的?|对应的?|相关的?|合适的?)$/;
// Descriptions of the target ("跑分析的那家") carry no task content.
const TARGET_DESCRIPTOR = /[^，。,.;；\s]{1,12}的(?:那家|那个|那边|那位|那拨人|那组|那帮人)/g;
// English words users commonly use for Chinese session titles; only used to decide
// "this reference fits several candidates", never to prove a target absent.
const EN_ALIASES: Readonly<Record<string, string>> = {
  refactor: '重构', refactoring: '重构', docs: '文档', documentation: '文档', migration: '迁移', perf: '性能', performance: '性能',
  payment: '支付', payments: '支付', website: '官网', mobile: '移动', testing: '测试', sandbox: '沙盒',
};

const STOP_BIGRAMS: ReadonlySet<string> = new Set(['会话', '对话', '这个', '那个', '任务', '一下', '这条', '一个']);

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s\-_「」"'“”()（）]/g, '');
}

function asciiTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
}

function bigrams(value: string): string[] {
  const cjk = value.replace(/[^一-鿿]/g, '');
  const result: string[] = [];
  for (let index = 0; index + 2 <= cjk.length; index += 1) result.push(cjk.slice(index, index + 2));
  return result.filter((gram) => !STOP_BIGRAMS.has(gram));
}

/** Generous on purpose: a missed match only means the rule stays silent, a spurious one only silences it. */
function withAliases(message: string): string {
  const lower = message.toLowerCase();
  const extra = Object.entries(EN_ALIASES).flatMap(([word, alias]) => (new RegExp(`\\b${word}\\b`).test(lower) ? [alias] : []));
  return extra.length > 0 ? `${message} ${extra.join(' ')}` : message;
}

function mentions(rawMessage: string, candidate: ClarifyGuardCandidate): boolean {
  const message = withAliases(rawMessage);
  const flat = normalize(message);
  const names = [candidate.shortName, candidate.workspaceName].map(normalize).filter((name) => name.length >= 2);
  if (names.some((name) => flat.includes(name))) return true;
  const lower = message.toLowerCase();
  const tokens = [...asciiTokens(candidate.shortName), ...asciiTokens(candidate.workspaceName)];
  if (tokens.some((token) => lower.includes(token))) return true;
  return bigrams(candidate.shortName).some((gram) => message.includes(gram));
}

function matchesAnyCandidateName(name: string, candidates: ReadonlyArray<ClarifyGuardCandidate>): boolean {
  const flat = normalize(name);
  if (flat.length === 0) return true;
  return candidates.some((candidate) => {
    const names = [candidate.shortName, candidate.workspaceName].map(normalize).filter((value) => value.length > 0);
    if (names.some((value) => value.includes(flat) || flat.includes(value))) return true;
    return asciiTokens(candidate.workspaceName).concat(asciiTokens(candidate.shortName)).some((token) => flat.includes(token) || token.includes(flat));
  });
}

function hasNamedTargetAbsent(message: string, candidates: ReadonlyArray<ClarifyGuardCandidate>): boolean {
  if (INDEFINITE_TARGET.test(message)) return true;
  for (const match of message.matchAll(QUOTED_TARGET)) {
    if (!matchesAnyCandidateName(match[1], candidates)) return true;
  }
  for (const match of message.matchAll(UNQUOTED_TARGET)) {
    const name = match[1].replace(/(?:的)$/, '');
    if (GENERIC_TARGET.test(name) || name.length < 2 || /新开|新建|新的|一个|另起|单开|开个/.test(name)) continue;
    if (!candidates.some((candidate) => mentions(name, candidate))) return true;
  }
  return false;
}

function contentUnits(text: string): number {
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const words = text.match(/[a-z0-9]+/gi)?.length ?? 0;
  return cjk + words;
}

function hasNoTaskContent(message: string, candidates: ReadonlyArray<ClarifyGuardCandidate>): boolean {
  let rest = message;
  for (const candidate of candidates) {
    for (const name of [candidate.shortName, candidate.workspaceName]) {
      if (name.trim().length >= 2) rest = rest.split(name).join(' ');
    }
  }
  const hasMarker = new RegExp(VAGUE_MARKER.source, 'i').test(rest);
  if (hasMarker) {
    return contentUnits(rest.replace(VAGUE_MARKER, ' ').replace(FILLER, ' ')) < VAGUE_MAX_UNITS;
  }
  if (ANAPHOR.test(message)) return false;
  return contentUnits(rest.replace(TARGET_DESCRIPTOR, ' ').replace(FILLER, ' ')) < 2;
}

/**
 * Evidence strength of "the user's words point at this candidate": a full title dominates, an ASCII token that
 * belongs to this candidate only counts 2, each shared Chinese bigram (or an English alias for one) counts 1.
 * Ambiguous = the best score is shared by two or more candidates and no full title was spoken.
 */
function scoreCandidates(rawMessage: string, candidates: ReadonlyArray<ClarifyGuardCandidate>): number[] {
  const message = withAliases(rawMessage);
  const flat = normalize(message);
  const lower = message.toLowerCase();
  const tokenOwners = new Map<string, number>();
  const tokensOf = candidates.map((candidate) => [...new Set([...asciiTokens(candidate.shortName), ...asciiTokens(candidate.workspaceName)])]);
  for (const tokens of tokensOf) for (const token of tokens) tokenOwners.set(token, (tokenOwners.get(token) ?? 0) + 1);
  return candidates.map((candidate, index) => {
    const title = normalize(candidate.shortName);
    let score = title.length >= 2 && flat.includes(title) ? FULL_TITLE_SCORE : 0;
    for (const token of tokensOf[index]) if (tokenOwners.get(token) === 1 && lower.includes(token)) score += 2;
    score += new Set(bigrams(candidate.shortName).filter((gram) => message.includes(gram))).size;
    return score;
  });
}

function isAmbiguousReference(rawMessage: string, candidates: ReadonlyArray<ClarifyGuardCandidate>): boolean {
  const scores = scoreCandidates(rawMessage, candidates);
  const top = Math.max(0, ...scores);
  return top > 0 && top < FULL_TITLE_SCORE && scores.filter((score) => score === top).length >= 2;
}

function candidateDisplayNames(candidates: ReadonlyArray<ClarifyGuardCandidate>): string[] {
  return [...new Set(candidates.map((candidate) => candidate.shortName.trim()).filter((name) => name.length > 0))].slice(
    0,
    MAX_QUESTION_CANDIDATES,
  );
}

function clarify(rule: ClarifyGuardRule, candidates: ReadonlyArray<ClarifyGuardCandidate>): ClarifyGuardVerdict {
  const candidateNames = candidateDisplayNames(candidates);
  const names = candidateNames.length > 0 ? ` Candidate chats (display names): ${candidateNames.map((name) => `「${name}」`).join('、')}.` : '';
  return {
    kind: 'clarify',
    rule,
    candidateNames,
    reason: 'unclear_target',
    message: `needs_clarification: the target chat is not clear enough to send this safely.${names} Nothing was delegated. Ask the user which chat they mean with AskUserQuestion, using those display names as the options (plain words, no ids); do not retry delegate_session until the user answers.`,
  };
}

function clarifyNonSingleAnswer(rule: ClarifyGuardRule, candidates: ReadonlyArray<ClarifyGuardCandidate>): ClarifyGuardVerdict {
  const candidateNames = candidateDisplayNames(candidates);
  const names = candidateNames.length > 0 ? `可选会话（显示名）：${candidateNames.map((name) => `「${name}」`).join('、')}。` : '';
  return {
    kind: 'clarify',
    rule,
    candidateNames,
    reason: 'non_single_answer',
    message: `needs_clarification: 一次交接只能发给一个会话，用户的回答未能唯一确定单个目标会话，本次没有发送任何内容。${names}请用 AskUserQuestion 重新让用户单选，每个选项只能是一个会话的显示名（纯文字、不含 id，禁止提供「两个都发」「两条都发」「都发」「全部」等选项）；在用户重新单选之前不要重试 delegate_session。如果重问后用户仍未单选单个会话，请停止调用本工具，直接用中文告知用户本次没有发送。`,
  };
}

export function evaluateClarifyGuard(input: ClarifyGuardInput): ClarifyGuardVerdict {
  const message = input.userMessage?.trim() ?? '';
  if (message === '') return { kind: 'proceed' };
  const { candidates } = input;

  // Naming an existing candidate while the model picked create_new is a disagreement about the
  // action, not evidence the user wanted a new session; leave that to the existing gates.
  if (input.action === 'create_new' && !NEW_INTENT_PATTERNS.some((pattern) => pattern.test(message))
    && !candidates.some((candidate) => mentions(message, candidate))) {
    return clarify('create_new_without_new_intent', candidates);
  }
  if (!(input.action === 'create_new') && hasNamedTargetAbsent(message, candidates)) return clarify('named_target_absent', candidates);
  if (hasNoTaskContent(message, candidates)) return clarify('vague_task_text', candidates);
  if (input.action === 'delegate_existing' && isAmbiguousReference(message, candidates)) return clarify('ambiguous_reference', candidates);
  if (input.action === 'delegate_existing' && input.chosenIndex !== null) {
    const named = candidates.flatMap((candidate, index) => (mentions(message, candidate) ? [index] : []));
    if (named.length > 0 && !named.includes(input.chosenIndex)) return clarify('named_other_candidate', candidates);
  }
  return { kind: 'proceed' };
}

/**
 * 澄清作答后的复核：用户通过 AskUserQuestion 真的点了答案之后，模型重试 delegate_session。
 * 只在答案文本里找证据：delegate_existing 的答案必须点到模型这次选的候选（点了别家 → 再问）；
 * create_new 的答案必须带显式新建意图；vague_task_text 被拒的那次，任何非空答案都算补了任务内容
 * （目标另按候选规则核）。答案文本里没有任何候选名且不满足上述条件 → 视为无关答案，不放行。
 */
export function evaluateClarifyAnswer(input: {
  rule: ClarifyGuardRule;
  action: 'delegate_existing' | 'create_new';
  candidates: ReadonlyArray<ClarifyGuardCandidate>;
  chosenIndex: number | null;
  answerText: string;
}): ClarifyGuardVerdict {
  const answer = input.answerText.trim();
  if (answer === '') return clarify(input.rule, input.candidates);
  if (input.action === 'create_new') {
    return input.rule === 'vague_task_text' || NEW_INTENT_PATTERNS.some((pattern) => pattern.test(answer))
      ? { kind: 'proceed' }
      : clarify(input.rule, input.candidates);
  }
  const scores = scoreCandidates(answer, input.candidates);
  const top = Math.max(0, ...scores);
  if (top > 0) {
    // 答案点到了某家：必须是唯一最高分，且就是模型这次要发的那家；多选并列按「未单选单个会话」引导单选重问。
    const winners = scores.flatMap((score, index) => (score === top ? [index] : []));
    if (winners.length === 1) {
      return winners[0] === input.chosenIndex ? { kind: 'proceed' } : clarify('named_other_candidate', input.candidates);
    }
    return clarifyNonSingleAnswer('named_other_candidate', input.candidates);
  }
  return input.rule === 'vague_task_text' ? { kind: 'proceed' } : clarifyNonSingleAnswer(input.rule, input.candidates);
}
