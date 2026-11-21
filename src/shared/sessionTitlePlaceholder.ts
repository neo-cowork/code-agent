// ============================================================================
// 会话标题占位判断与无模型降级标题
// 自动起标题、遥测回填、CLI 回填只允许覆盖这一档。
// ============================================================================

import { stripAppshotBlocks } from './contract/appshot';
import { isTelemetryRecoveryNoticeResidue, stripTelemetryRecoveryNoticeOrResidue } from './telemetryRecovery';

/** 纯 appshot 会话的固定名（按语言）。存量行里的中文名在展示层经 localizeAppshotSessionTitle 转换。 */
const APPSHOT_SESSION_TITLE = { zh: 'Appshot 会话', en: 'Appshot conversation' } as const;
type TitleLanguage = keyof typeof APPSHOT_SESSION_TITLE;

/** `/init-memory` 会话的确定性标题（斜杠展开只在模型面，小模型只看得到字面命令，会编出像内部提示名的标题）。 */
const INIT_MEMORY_SESSION_TITLE = { zh: '初始化项目记忆', en: 'Set up project memory' } as const;
const INIT_MEMORY_COMMAND = /^\/init-memory(?:\s|$)/;

/** 首条消息是 `/init-memory`（可带参数）时返回确定性标题，否则 null。folderName 缺省则不带文件夹部分。 */
export function deriveInitMemorySessionTitle(
  message: string,
  language: TitleLanguage,
  folderName?: string,
): string | null {
  if (!INIT_MEMORY_COMMAND.test(message.trim())) return null;
  const base = INIT_MEMORY_SESSION_TITLE[language];
  const folder = folderName?.trim();
  return folder ? `${base} · ${folder}` : base;
}

/** 英文 UI 下把存量/新写入的 Appshot 固定名显示成英文；其它标题原样返回。 */
export function localizeAppshotSessionTitle(title: string, language: TitleLanguage): string {
  return title === APPSHOT_SESSION_TITLE.zh || title === APPSHOT_SESSION_TITLE.en
    ? APPSHOT_SESSION_TITLE[language]
    : title;
}

const EXACT_PLACEHOLDER_TITLES = new Set([
  'New Chat',
  'New Session',
  'New conversation',
  '新对话',
  '新会话',
  'CLI Session',
]);

/** 空白、默认档、以及 `Session ` / `CLI Session ` 前缀都还没被命过名。 */
export function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  const named = title?.trim() ?? '';
  if (!named) return true;
  if (EXACT_PLACEHOLDER_TITLES.has(named)) return true;
  return named.startsWith('Session ') || named.startsWith('CLI Session ');
}

/**
 * 剥掉旧恢复提示前缀与 appshot 块后留给小模型和降级标题的正文。纯 appshot 用固定名。
 * 只剩恢复提示（含截断残留）时返回空串：调用方按「不起标题、保留占位」处理。
 */
export function sessionTitleSource(sourceText: string, language: TitleLanguage = 'zh'): string {
  const cleaned = stripTelemetryRecoveryNoticeOrResidue(sourceText);
  const visibleMessage = stripAppshotBlocks(cleaned);
  return visibleMessage || (cleaned.trim().startsWith('<appshot') ? APPSHOT_SESSION_TITLE[language] : cleaned);
}

/**
 * 「未定档」标题：占位档，或 web 预写层为防 sidebar 闪「新对话」先升成的
 * 「prompt 头部 + ...」临时档（buildSessionTitle 的 30 字截断，
 * deriveFallbackSessionTitle 的 50 字降级同形）。两者都是自动产物不是用户命名，
 * 智能标题到位后应替换；不认临时档时 web 会话的占位门槛会永远拦住
 * maybeUpdateTitleForSession，智能标题结构性不可达（N-DELIVERABLE-WORKDIR-LAZY-FU3 实测）。
 */
export function isProvisionalAutoTitle(title: string | null | undefined, sourceText: string): boolean {
  if (isPlaceholderSessionTitle(title)) return true;
  const named = (title ?? '').trim();
  // 旧预写层把恢复提示截进了临时标题：来源经 sessionTitleSource 剥掉前缀后，前缀比对必失配；
  // 但以提示开头的标题必是自动产物而非用户命名，仍按未定档处理，好让干净标题顶上。
  if (named && isTelemetryRecoveryNoticeResidue(named)) return true;
  // web 预写层对 <=30 字的 prompt 整句写入、不带 `...`：与首行相同同样是自动产物。
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
  if (named && flat(named) === flat(sourceText.trimStart().split('\n')[0] ?? '')) return true;
  if (!named.endsWith('...')) return false;
  const slice = named.slice(0, -3);
  if (!slice) return false;
  return sourceText.startsWith(slice) || sourceText.trimStart().startsWith(slice);
}

/**
 * 云端 sessions 行回灌本地的标题守卫（FB-1089）：云端行只在新会话时写过 web 首轮的
 * 自动标题（buildSessionTitle 30 字截断；≤30 字 prompt 原样入列不带 `...`），此后
 * 每轮只顶 updated_at——时间戳上永远「更新」。本地标题已定档（智能标题或用户命名，
 * 非占位、非截断）而云端仍是这类自动产物时保留本地；云端是真改名（非自动档）时
 * 照旧云端取胜。sourceText 传会话第一条可见用户消息原文。
 */
export function shouldKeepLocalTitleOverCloud(
  localTitle: string | null | undefined,
  cloudTitle: string | null | undefined,
  sourceText: string,
): boolean {
  const cloudIsAutoTitle = isProvisionalAutoTitle(cloudTitle, sourceText)
    || (typeof cloudTitle === 'string' && cloudTitle.trim() === sourceText.trim());
  if (!cloudIsAutoTitle) return false;
  return !isProvisionalAutoTitle(localTitle, sourceText);
}

/** 小模型不可用时的标题：首行，最多 50 字，超出加 `...`。来源只剩恢复提示时返回空串 = 不起标题，保留占位。 */
export function deriveFallbackSessionTitle(sourceText: string, language: TitleLanguage = 'zh'): string {
  const source = sessionTitleSource(sourceText, language);
  if (!source.trim()) return '';
  const firstLine = source.trim().split('\n')[0];
  const title = firstLine.slice(0, 50);
  return firstLine.length > 50 ? `${title}...` : title;
}

const TITLE_RULE_MAX_CHARS = 20;
const TITLE_ECHO_EXEMPT_MAX_CHARS = 8;
/** 会话标题在 20 字词边界之后继续补整词的上限（码点）。文件夹命名不走这条。 */
const TITLE_FRAGMENT_MAX_CHARS = 40;
/** 英文功能词。截在这些词上会留下 `Write the` 这种半截标题；中文无空格，不另做虚词表。 */
const FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'at',
  'with', 'by', 'from', 'into', 'about', 'as', 'is', 'are', 'be',
]);
const CLAUSE_SPLIT = /[，。；：！？,;:!?\n]|\.(?=\s|$)/;
const REQUEST_BOILERPLATE =
  /^(?:我把|请你帮我|请帮我|请你|请|帮我|麻烦你|麻烦|能不能|可不可以|能否|可以|我想要|我想|我需要你|我需要|please|can you|could you|would you|help me|i need you to|i want you to|i'd like you to|i need|i want)(?![a-z])\s*/i;

function firstLineOf(sourceText: string): string {
  return sourceText.trim().split('\n')[0]?.trim() ?? '';
}

/** 标题是否只是首条消息的前缀（或反过来）：即「回声」。斜杠命令与 <=8 字首行豁免。 */
function isEchoSessionTitle(title: string, sourceText: string): boolean {
  const first = firstLineOf(sourceText);
  if (/^\/[\w:.-]+$/.test(first) || Array.from(first).length <= TITLE_ECHO_EXEMPT_MAX_CHARS) return false;
  const tn = title.replace(/(?:\.\.\.|…)+$/, '').trim();
  if (!tn) return false;
  if (tn.length < 10 && tn === title.trim()) return false;
  const fun = sourceText.replace(/\s*\n\s*/g, ' ').trim();
  return [first, fun].some((f) => f.startsWith(tn) || (f.length >= 6 && tn.startsWith(f)));
}

function isFunctionWord(word: string): boolean {
  return FUNCTION_WORDS.has(word.toLowerCase());
}

/** 无空格（中文）不算碎片。有空格时，停在功能词上或实词不足两个，侧栏读起来像半截。 */
function isTitleFragment(title: string): boolean {
  if (!title.includes(' ')) return false;
  const words = title.split(' ').filter((word) => word.length > 0);
  const last = words[words.length - 1];
  if (!last) return false;
  const contentWords = words.filter((word) => !isFunctionWord(word)).length;
  return isFunctionWord(last) || contentWords < 2;
}

/**
 * 20 字词边界之后：碎片且后面还有整词，就继续补，直到落在实词上且至少两个实词。
 * 补完会超过 40 个码点则退回 50 字降级标题。
 */
function avoidFunctionWordFragment(
  cut: string,
  clause: string,
  sourceText: string,
  language: TitleLanguage,
): string {
  if (!isTitleFragment(cut)) return cut;
  const clauseWords = clause.split(' ').filter((word) => word.length > 0);
  let included = 0;
  let prefix = '';
  for (const word of clauseWords) {
    const next = prefix ? `${prefix} ${word}` : word;
    if (cut === next || cut.startsWith(`${next} `)) {
      prefix = next;
      included += 1;
      continue;
    }
    break;
  }
  if (included >= clauseWords.length) return cut;

  const words = clauseWords.slice(0, included);
  for (let index = included; index < clauseWords.length; index += 1) {
    const word = clauseWords[index];
    if (word === undefined) break;
    const candidate = [...words, word].join(' ');
    if (Array.from(candidate).length > TITLE_FRAGMENT_MAX_CHARS) {
      return deriveFallbackSessionTitle(sourceText, language);
    }
    words.push(word);
    if (!isTitleFragment(candidate)) return candidate;
  }
  return words.join(' ');
}

/** 无模型 / 模型仍回声时的规则摘要：首行首个分句去掉请求套话，最多 20 字，不带 `...`。来源只剩恢复提示时返回空串。 */
export function deriveRuleSummaryTitle(
  sourceText: string,
  language: TitleLanguage = 'zh',
  options?: { avoidFragment?: boolean },
): string {
  const source = sessionTitleSource(sourceText, language);
  if (!source.trim()) return '';
  const first = firstLineOf(source) || APPSHOT_SESSION_TITLE[language];
  let clause = (first.split(CLAUSE_SPLIT).find((part) => part.trim()) ?? first).trim();
  for (let i = 0; i < 3; i++) {
    const next = clause.replace(REQUEST_BOILERPLATE, '').trim();
    if (next === clause) break;
    clause = next;
  }
  const chars = Array.from(clause || first);
  if (chars.length <= TITLE_RULE_MAX_CHARS) return chars.join('');
  const cut = chars.slice(0, TITLE_RULE_MAX_CHARS).join('');
  // 拉丁文按词截，不把单词劈在半截；中文无空格照字截。
  const lastSpace = cut.lastIndexOf(' ');
  const bounded = chars[TITLE_RULE_MAX_CHARS] !== ' ' && lastSpace >= 8 ? cut.slice(0, lastSpace) : cut.trimEnd();
  if (!options?.avoidFragment) return bounded;
  return avoidFunctionWordFragment(bounded, clause || first, sourceText, language);
}

export interface SessionTitleModelAnswer {
  title: string | null;
  /** 小模型本身不可用（区别于调用了但没产出）。 */
  unavailable?: boolean;
}

interface SessionTitleLog {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

/** 模型标题 -> 回声检查 -> 带更严指令重试一次 -> 规则摘要；每次降级都留痕。 */
export async function resolveSessionTitle(
  sourceText: string,
  language: TitleLanguage,
  ask: (strict: boolean) => Promise<SessionTitleModelAnswer>,
  log: SessionTitleLog,
): Promise<string> {
  const first = await ask(false);
  if (first.unavailable) {
    log.warn('quick model unavailable -> rule summary');
    return deriveRuleSummaryTitle(sourceText, language, { avoidFragment: true });
  }
  if (first.title && !isEchoSessionTitle(first.title, sourceText)) {
    log.info('title from quick model', { title: first.title });
    return first.title;
  }
  if (!first.title) {
    log.warn('quick model returned no title -> rule summary');
    return deriveRuleSummaryTitle(sourceText, language, { avoidFragment: true });
  }
  log.warn('title echo detected -> retry', { title: first.title });
  const retry = await ask(true);
  if (retry.title && !isEchoSessionTitle(retry.title, sourceText)) {
    log.info('title from quick model (strict retry)', { title: retry.title });
    return retry.title;
  }
  log.warn('retry still echo -> rule summary', { title: retry.title });
  return deriveRuleSummaryTitle(sourceText, language, { avoidFragment: true });
}
