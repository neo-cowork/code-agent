// ============================================================================
// 会话标题占位判断与无模型降级标题
// 自动起标题、遥测回填、CLI 回填只允许覆盖这一档。
// ============================================================================

import { stripAppshotBlocks } from './contract/appshot';

/** 纯 appshot 会话的固定名（按语言）。存量行里的中文名在展示层经 localizeAppshotSessionTitle 转换。 */
const APPSHOT_SESSION_TITLE = { zh: 'Appshot 会话', en: 'Appshot conversation' } as const;
type TitleLanguage = keyof typeof APPSHOT_SESSION_TITLE;

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

/** 剥掉 appshot 块后留给小模型和降级标题的正文。纯 appshot 用固定名。 */
export function sessionTitleSource(sourceText: string, language: TitleLanguage = 'zh'): string {
  const visibleMessage = stripAppshotBlocks(sourceText);
  return visibleMessage || (sourceText.trim().startsWith('<appshot') ? APPSHOT_SESSION_TITLE[language] : sourceText);
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

/** 小模型不可用时的标题：首行，最多 50 字，超出加 `...`。 */
export function deriveFallbackSessionTitle(sourceText: string, language: TitleLanguage = 'zh'): string {
  const firstLine = sessionTitleSource(sourceText, language).trim().split('\n')[0] || APPSHOT_SESSION_TITLE[language];
  const title = firstLine.slice(0, 50);
  return firstLine.length > 50 ? `${title}...` : title;
}
