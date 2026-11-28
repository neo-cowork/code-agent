// ============================================================================
// Truncate Utilities - 智能文本截断
// ============================================================================
//
// 借鉴 Codex CLI 的中间截断策略：保留首尾，截断中间。
// 模型通常需要看到输出的开头（错误信息、结构信息）和结尾（总结、状态）。

/**
 * 中间截断 — 保留首尾，截断中间
 *
 * 在行边界截断，避免截断一行的中间。
 *
 * @param text - 原始文本
 * @param maxLength - 最大字符数
 * @param headRatio - 头部占比（默认 0.5，即各占一半）
 * @returns 截断后的文本，如果未超限则返回原文
 */
export function truncateMiddle(
  text: string,
  maxLength: number,
  headRatio = 0.5
): string {
  if (text.length <= maxLength) return text;

  const reserveForMarker = 60; // "[N characters truncated]" 标记预留
  // 预算 <= 0（maxLength <= 预留）时头尾 substring 全空，只剩可能超长的纯标记
  // → 降级走头部截断（保留行边界偏好），codex audit LOW 修订
  if (maxLength <= reserveForMarker) {
    const headPart = text.substring(0, maxLength);
    const headEnd = headPart.lastIndexOf('\n');
    const cleanHead = headEnd > maxLength * 0.5 ? headPart.substring(0, headEnd) : headPart;
    return `${cleanHead}\n... (output truncated)`;
  }
  const budget = maxLength - reserveForMarker;
  const headBudget = Math.floor(budget * headRatio);
  const tailBudget = budget - headBudget;

  // 在行边界截断
  const headPart = text.substring(0, headBudget);
  const tailPart = text.substring(text.length - tailBudget);

  const headEnd = headPart.lastIndexOf('\n');
  const tailStart = tailPart.indexOf('\n');

  const cleanHead = headEnd > headBudget * 0.5
    ? headPart.substring(0, headEnd)
    : headPart;

  const cleanTail = tailStart >= 0 && tailStart < tailBudget * 0.5
    ? tailPart.substring(tailStart + 1)
    : tailPart;

  const removed = text.length - cleanHead.length - cleanTail.length;

  return `${cleanHead}\n\n... [${removed} characters truncated] ...\n\n${cleanTail}`;
}

// 错误感知截断（借鉴 MiMoCode tool/truncate.ts 的设计）：
// 截断前扫描输出尾部找错误模式，命中则头 70%/尾 30% 分配预算保住报错信息。
const ERROR_PATTERN = /error|exception|failed|fatal|traceback|panic|exit code/i;
const TAIL_SCAN_CHARS = 2048;
const ERROR_AWARE_HEAD_RATIO = 0.7;

/**
 * 错误感知的中间截断 — 尾部含错误模式时偏向保留头部预算（70/30），
 * 否则退回默认 50/50 的 truncateMiddle 行为。
 *
 * @param text - 原始文本
 * @param maxLength - 最大字符数
 * @returns 截断后的文本，如果未超限则返回原文
 */
export function truncateMiddleErrorAware(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const tailScan = text.length > TAIL_SCAN_CHARS ? text.slice(-TAIL_SCAN_CHARS) : text;
  const headRatio = ERROR_PATTERN.test(tailScan) ? ERROR_AWARE_HEAD_RATIO : 0.5;
  return truncateMiddle(text, maxLength, headRatio);
}

/**
 * 头部截断（旧行为兼容）— 只保留开头
 *
 * @param text - 原始文本
 * @param maxLength - 最大字符数
 * @returns 截断后的文本
 */
export function truncateHead(
  text: string,
  maxLength: number
): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '\n... (output truncated)';
}

// ============================================================================
// 整词截断 — 用户可见任务标题不得切出半个词（FB-3029 / FB-1933）
// ============================================================================

const CLAUSE_PUNCTUATION = new Set(['，', '。', ',', '.', ';', '；']);
const MIN_CLAUSE_PREFIX_CODE_POINTS = 8;
const CJK_SEGMENT_LOCALE_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const FALLBACK_BOUNDARY_CHAR = /[\s\p{P}]/u;
const TRAILING_NON_WORD_CHARS = /[\s\p{P}]+$/u;

/**
 * 整词截断 — 预算（码位）内只保留完整分词段
 *
 * 未超预算时原文返回（调用方据此决定是否加省略号）。超预算时：
 * 1. 优先落在预算内最后一个句读边界（，。,.;；），前提是它之前留下至少 8 个码位；
 * 2. 否则用 Intl.Segmenter 词粒度分段，保留完整段并丢弃尾随的空白/标点段；
 * 3. 运行时没有 Intl.Segmenter 时退回预算内最后一个空白或标点；
 * 4. 预算内找不到任何边界（整段是一个长 token / URL）时返回 undefined，
 *    由调用方决定回落（固定文案或旧的硬切）。
 *
 * @param text - 已归一化的文本（调用方负责折叠空白）
 * @param maxCodePoints - 码位预算（正文部分，不含省略号）
 * @returns 原文或「截断文本 + …」；无可用边界时 undefined
 */
export function truncateAtWordBoundary(text: string, maxCodePoints: number): string | undefined {
  const chars = Array.from(text);
  if (chars.length <= maxCodePoints) return text;

  const lastInBudget = Math.min(maxCodePoints, chars.length - 1);
  for (let i = lastInBudget; i >= MIN_CLAUSE_PREFIX_CODE_POINTS; i--) {
    if (CLAUSE_PUNCTUATION.has(chars[i])) {
      const head = chars.slice(0, i).join('').trimEnd();
      if (head) return `${head}…`;
      break;
    }
  }

  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(CJK_SEGMENT_LOCALE_PATTERN.test(text) ? 'zh' : 'en', { granularity: 'word' });
    let cut = '';
    let pending = '';
    let used = 0;
    for (const part of segmenter.segment(text)) {
      used += Array.from(part.segment).length;
      if (used > maxCodePoints) break;
      pending += part.segment;
      if (part.isWordLike) cut = pending;
    }
    return cut ? `${cut}…` : undefined;
  }

  for (let i = lastInBudget; i > 0; i--) {
    if (FALLBACK_BOUNDARY_CHAR.test(chars[i])) {
      const head = chars.slice(0, i).join('').replace(TRAILING_NON_WORD_CHARS, '');
      return head ? `${head}…` : undefined;
    }
  }
  return undefined;
}
