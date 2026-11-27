// ============================================================================
// 任务证据的语义化翻译层（ADR-050 依赖 A）
//
// blockedReason / completionEvidence 最终要展示给非程序员协作者。模型经常直接把
// raw error（stack trace / JSON 响应体 / "AxiosError: Request failed with status
// code 403"）塞进来，这层负责：
//   1. 把机器噪音剥掉，只留能读的散文；
//   2. 用已有的 ErrorClassifier 推断语义类别，让 UI 用自己的 i18n 文案兜底，
//      而不是把英文报错原样怼到用户脸上。
// 原始文本不丢——它进 session_task_events 的 summary 供排错。
//
// 住在 shared/ 而不是 host/：run 卡片与 tool 卡片的阻塞原因在 renderer 侧投影时
// 才拿到（runWorkbenchProjection），和任务轨走同一套清洗才不会一边说人话一边贴
// stack trace。本文件无 host 依赖，只用 shared 的类型。
// ============================================================================

import type { TaskBlockedCategory } from './contract/planning';
import { hasInsufficientBalanceSignal } from './utils/providerError';

/** 展示用文本上限：一行提示的量级，超出说明模型在贴日志 */
const MAX_DISPLAY_LENGTH = 160;

/** 机器噪音特征：命中任意一条就认为这段不是写给人看的 */
const MACHINE_NOISE_PATTERNS: RegExp[] = [
  /^\s*[{[]/,                       // JSON / 数组响应体
  /\bat\s+[\w$.<>]+\s*\([^)]*:\d+:\d+\)/, // stack frame
  /^\s*at\s+\S+:\d+:\d+/m,
  /\b[A-Z][\w.]*Error\b:/,          // TypeError: / AxiosError:
  /\b(?:E[A-Z]{3,}|ERR_[A-Z_]+)\b/, // ECONNREFUSED / ERR_BAD_REQUEST
  /\bTraceback \(most recent call last\)/,
  /\bstatus\s*code\s*\d{3}\b/i,
  /<\/?[a-z]+[^>]*>/i,              // HTML 片段
  // JS 运行时异常文案（V8 固定输出，无 "TypeError:" 前缀也命中，FB-746；
  // 兼容旧版单数形式 Cannot read property 'x' of undefined）
  /Cannot read propert(?:y|ies)(?: '[^']*')? of (?:undefined|null)/,
  /\bis not a function\b/,
  /\bis not defined\b/,
  /\bUnexpected token\b/,
  // 运行时租约术语（如 Durable Run … has no live owner lease）——机内状态机文案
  /\bowner lease\b/i,
];

function looksMachineGenerated(text: string): boolean {
  return MACHINE_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

function truncate(text: string): string {
  return text.length <= MAX_DISPLAY_LENGTH
    ? text
    : `${text.slice(0, MAX_DISPLAY_LENGTH - 1).trimEnd()}…`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 类别识别只认英文机器特征——中文散文原因会落到 unknown，正是我们想要的：
 * 认不出来就别猜，保留模型自己的话。
 *
 * 没有复用已删除的 src/host/errors/errorClassifier.ts：那整个 errors/ 模块当年就是
 * 死代码（knip unused files，2026-10 孤儿清理已删），为了一次类别查表把 484 行
 * 无人维护的模式表拖进活引用图不划算。这里只需要展示层用得上的这几类。
 */
const CATEGORY_PATTERNS: Array<[TaskBlockedCategory, RegExp]> = [
  ['rate_limit', /\b429\b|rate.?limit|too many requests|quota/i],
  ['permission', /\b40[13]\b|forbidden|unauthorized|permission denied|access denied|EACCES|requires? (?:a )?(?:login|sign.?in)/i],
  ['resource', /\b404\b|not found|ENOENT|no such file/i],
  ['network', /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|getaddrinfo|fetch failed|network error|timed? ?out/i],
  ['model', /context length|content policy|model (?:not available|overloaded)/i],
  ['tool', /tool (?:not found|failed)|command not found|exit code [1-9]/i],
];

function toBlockedCategory(raw: string): TaskBlockedCategory {
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(raw)) return category;
  }
  return 'unknown';
}

export interface TaskBlockedReasonDescription {
  /** 可直接展示的说明；模型贴的是纯日志时为空串，由 UI 用 category 文案兜底 */
  reason: string;
  category: TaskBlockedCategory;
}

/**
 * 把 agent 写的阻塞原因翻成可展示的说明 + 语义类别。
 */
export function describeTaskBlockedReason(raw: string): TaskBlockedReasonDescription {
  const normalized = collapseWhitespace(raw);
  const category = toBlockedCategory(normalized);
  return {
    reason: looksMachineGenerated(normalized) ? '' : truncate(normalized),
    category,
  };
}

/** `[文字](链接)` 只留文字；裸链接连同紧贴它的短标签（「充值地址：」「Recharge at:」）一起去掉 */
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]*)\]\([^)\s]*\)/g;
const URL_WITH_LABEL_PATTERN = /(?:[^\s。！？.!?；;，,：:][^。！？.!?；;，,：:\n]{0,23}[:：]\s*)?<?(?:https?:\/\/|www\.)[^\s<>"'）)】」，。；！？]+>?/gi;
/** 行首的标题/列表/引用记号 */
const LINE_MARKER_PATTERN = /^[ \t]*(?:#{1,6}[ \t]*|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]*)+/gm;
const FIRST_SENTENCE_PATTERN = /^.*?(?:[。！？!?]+|\.(?=\s|$))/;
const HAN_PATTERN = /\p{Script=Han}/u;

function stripMarkdownAndUrls(raw: string): string {
  return raw
    .replace(MARKDOWN_LINK_PATTERN, '$1')
    .replace(URL_WITH_LABEL_PATTERN, '')
    .replace(/[（(【[]\s*[）)】\]]/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(LINE_MARKER_PATTERN, '')
    .replace(/\*(?=\S)([^*\n]+?)\*/g, '$1');
}

/** 表格行、分隔线不是一句话：挑第一句时跳过 */
const TABLE_OR_RULE_LINE_PATTERN = /^(?:\|.*|[-=:| ]{3,})$/;
/** 第一句总在开头附近；只清洗这一段，整屏日志不必全量过正则 */
const REASON_SCAN_LENGTH = 2000;

function firstSentence(text: string): string {
  const line = text.split('\n').map((item) => item.trim()).find((item) => item && !TABLE_OR_RULE_LINE_PATTERN.test(item)) ?? '';
  return (FIRST_SENTENCE_PATTERN.exec(line)?.[0] ?? line).replace(/[:：]\s*$/, '').trim();
}

interface BackgroundFailureDescription extends TaskBlockedReasonDescription {
  /** 原始报错全文；与 reason 相同时不给（没有更多可看的） */
  detail?: string;
}

/**
 * 后台任务失败行用的一句话原因：去掉 markdown 记号与链接，只留第一句，
 * 文字与界面语言不符（中文界面里的纯英文、英文界面里的中文）时给空串，
 * 由 UI 用 category 文案兜底。原文放在 detail，展开后才显示。
 */
export function describeBackgroundFailure(raw: string, language: 'zh' | 'en'): BackgroundFailureDescription {
  const trimmed = raw.trim();
  const described = describeTaskBlockedReason(firstSentence(stripMarkdownAndUrls(trimmed.slice(0, REASON_SCAN_LENGTH))));
  const matchesLanguage = HAN_PATTERN.test(described.reason) === (language === 'zh');
  const reason = matchesLanguage ? described.reason : '';
  const category = hasInsufficientBalanceSignal(trimmed) ? 'model' : describeTaskBlockedReason(trimmed).category;
  return { reason, category, ...(trimmed && trimmed !== reason ? { detail: trimmed } : {}) };
}

/**
 * 完成证据同样会出现在交接摘要/任务详情里，做同样的噪音清洗。
 * 与阻塞原因不同的是这里不丢弃内容——证据本身就可能是命令输出，
 * 只压缩空白并截断，保证不把整屏日志灌进账本。
 */
export function sanitizeTaskEvidenceText(raw: string): string {
  return truncate(collapseWhitespace(raw));
}
