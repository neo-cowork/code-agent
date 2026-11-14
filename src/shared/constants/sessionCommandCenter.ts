import { INTERACTION_TIMEOUTS } from './timeouts';

/**
 * 后台任务禁止递归调用的指挥台调度工具。
 * 这份拒绝集不决定文字前台工具面；前台只消费 ToolSchema.allowInTextForeground。
 */
export const SESSION_COMMAND_CENTER_TOOL_NAMES = [
  'delegate_task',
  'spawn_agent',
  'steer_task',
  'cancel_task',
  'task_status',
] as const;

/** Foreground brain should route or answer without growing into an execution run. */
export const SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS = 8;

/** File execution and resuming a step-limited turn need room beyond routing. */
const SESSION_COMMAND_CENTER_DELIVERABLE_MAX_ITERATIONS = 30;

// Deliverable nouns only: PPT(X)/PowerPoint/slides/幻灯片/演示稿, XLS(X)/Excel/
// spreadsheet/表格, DOC(X)/Word/document/report/文档/报告, PDF, HTML/webpage/网页.
// Latin boundaries avoid incidental substrings (e.g. “wordpress”, “excellent”).
const FOREGROUND_DELIVERABLE_RE = /\b(?:pptx?|powerpoint|slides?|xlsx?|excel|spreadsheet|docx?|word|document|report|pdf|html|webpage)\b|幻灯片|演示稿|表格|文档|报告|网页/i;

/** Pure per-turn budget policy; continuation is derived from persisted metadata. */
export function resolveForegroundBrainMaxIterations(input: {
  prompt: string;
  lastAssistantStoppedByStepLimit: boolean;
}): number {
  return input.lastAssistantStoppedByStepLimit || FOREGROUND_DELIVERABLE_RE.test(input.prompt)
    ? SESSION_COMMAND_CENTER_DELIVERABLE_MAX_ITERATIONS
    : SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS;
}

/** Hidden task-result wakes get a deliberately small reasoning budget. */
export const SESSION_COMMAND_CENTER_WAKE_MAX_ITERATIONS = 4;

/** Deferred foreground wakes surface a durable conversation note after this wait. */
export const BACKGROUND_WAKE_DEFER_NOTICE_MS = 10_000;

/**
 * A wake whose session cannot be loaded for the current owner (login still being restored)
 * is retried on a timer in addition to the auth-change signal. Total load attempts include the first.
 */
export const BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS = 6;
export const BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS = 5_000;

/** Keep the task title readable when it is embedded in the deferred-wake conversation note. */
export const BACKGROUND_WAKE_DEFER_TASK_TITLE_MAX_CHARS = 80;

/** Human progress shown while a completed background task is waiting for the foreground turn. */
export const BACKGROUND_WAKE_DEFER_PROGRESS = {
  completed: '后台任务已完成，等待汇报',
  failed: '后台任务已失败，等待汇报',
} as const;

/** Conversation copy used when a deferred wake reaches the visible-notice cap. */
export function formatBackgroundWakeDeferredNote(
  shortName: string,
  status: keyof typeof BACKGROUND_WAKE_DEFER_PROGRESS,
): string {
  const outcome = status === 'completed' ? '完成' : '失败';
  return `后台任务「${shortName}」已${outcome}，结果见上方的任务结果；当前步骤结束后，我会继续汇报。`;
}

/**
 * Prevent an autonomous task chain from waking the same conversation forever.
 * A new visible user message resets this counter.
 */
export const MAX_CONSECUTIVE_WAKES = 3;

/**
 * How long a background session-command run may go without an agent event
 * before the slot is failed. Voice does not use this clock.
 */
export const SESSION_COMMAND_TASK_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

const SESSION_COMMAND_TASK_IDLE_TIMEOUT_ENV = 'CODE_AGENT_SESSION_TASK_IDLE_TIMEOUT_MS';

/** Sole reader of CODE_AGENT_SESSION_TASK_IDLE_TIMEOUT_MS. Invalid values keep the fallback. */
export function resolveSessionCommandTaskIdleTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs = SESSION_COMMAND_TASK_IDLE_TIMEOUT_MS,
): number {
  const raw = env[SESSION_COMMAND_TASK_IDLE_TIMEOUT_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallbackMs;
  return parsed;
}

/**
 * 未答审批最多给一个后台任务续多久：超过后审批豁免停止，空闲回收链照常
 * fail + cancel + 唤醒。默认沿用无人值守停车审批的 24h 兜底数字，不另造魔法数。
 */
export const SESSION_COMMAND_TASK_APPROVAL_WAIT_CAP_MS = INTERACTION_TIMEOUTS.PARKED_APPROVAL;

const SESSION_COMMAND_TASK_APPROVAL_WAIT_CAP_ENV = 'CODE_AGENT_SESSION_TASK_APPROVAL_WAIT_CAP_MS';

/** Sole reader of CODE_AGENT_SESSION_TASK_APPROVAL_WAIT_CAP_MS. Invalid values keep the fallback. */
export function resolveSessionCommandTaskApprovalWaitCapMs(
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs = SESSION_COMMAND_TASK_APPROVAL_WAIT_CAP_MS,
): number {
  const raw = env[SESSION_COMMAND_TASK_APPROVAL_WAIT_CAP_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallbackMs;
  return parsed;
}

/**
 * 模型侧任务结果文本（resultText）的封顶字符数。UI/账本仍用 240 字 summary；
 * 前台模型读到的是这份宽松上限——SSRF 拒绝提示里的「改走 Bash curl 审批」整句
 * 必须完整到达前台，否则前台不知道下一步能做什么（FB-577）。
 */
const SESSION_COMMAND_TASK_RESULT_MODEL_MAX_CHARS = 1500;

/**
 * resultText 的单一真源：detail 规范化空白后封顶；超限保留前缀并显式标注总长，
 * 让模型知道文本被裁过。空 detail 返回 undefined——消费点回落 240 字 summary。
 * 按 code point 计数，与 compactSummary 的口径一致。
 */
export function composeSessionCommandTaskResultText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  const chars = Array.from(normalized);
  if (chars.length <= SESSION_COMMAND_TASK_RESULT_MODEL_MAX_CHARS) return chars.join('');
  return `${chars.slice(0, SESSION_COMMAND_TASK_RESULT_MODEL_MAX_CHARS).join('')}…(truncated, ${chars.length} chars total)`;
}

/**
 * [任务结果] 行的状态词（给人读的）：正文里不再露英文机读 token（failed/completed）。
 * metadata.backgroundTaskResult.status 仍保持机器可读原值，渲染端/账本不受影响。
 */
const SESSION_TASK_RESULT_STATUS_WORDS = {
  zh: { completed: '已完成', failed: '已失败', cancelled: '已取消' },
  en: { completed: 'finished', failed: 'failed', cancelled: 'cancelled' },
} as const;

export type SessionTaskResultStatusWordLocale = keyof typeof SESSION_TASK_RESULT_STATUS_WORDS;

export function formatSessionTaskResultStatusWord(
  status: 'completed' | 'failed' | 'cancelled',
  locale: SessionTaskResultStatusWordLocale,
): string {
  return SESSION_TASK_RESULT_STATUS_WORDS[locale][status];
}

/**
 * task_status 同 turn 去重（N-FIX-BGTASK-STATUS-POLL-TRIPLE-CARDS-REST1）：
 * 派活后模型常在几秒内连查 2-3 次 task_status，每次全量回答都重画一张「进行中」卡片。
 * 按会话保存「上次回答签名 + 下发时的 turnId」，同 turn 且签名未变时改回一句短提示。
 * 这里只放条目上限（超限按最旧淘汰）与短提示固定句；签名口径在
 * src/host/tools/modules/commandCenter/taskStatusDedupe.ts。
 */
export const TASK_STATUS_DEDUPE_MAX_SESSIONS = 64;

/** 签名未变时 task_status 回给模型的固定短提示；标识符行由 helper 按全量口径追加。 */
export const TASK_STATUS_UNCHANGED_HINT = '任务状态与上次查询一致，没有新变化；任务完成时会自动通知你，无需再次调用 task_status，也不要估算剩余完成时间。';

/**
 * 去重提示里子代理行的标题宽度；与 backgroundSubagentTaskRows 全量行的截断宽度同值，
 * 提示行与全量行不出现两个名字。该处常量未导出，这里只能同值另立，改动须同步。
 */
export const TASK_STATUS_HINT_TITLE_MAX_CHARS = 30;

/**
 * 判据单一真源：本轮是否套用指挥台 brain。
 *
 * 桌面（agentAppService）和 web（routes/agent.ts）两条路各自把工具面/迭代上限/系统上下文
 * 装配进**不同形状**的配置对象（AppServiceRunOptions vs AgentConfig），装配代码没法共用；
 * 但**判据**必须只有一份，否则改一处漏一处——本仓已两次栽在「修了桌面漏了 web」。
 */
export function isSessionCommandCenterTurn(input: {
  prompt: string;
  hasGoal: boolean;
}): boolean {
  return !input.hasGoal && !input.prompt.trimStart().startsWith('/');
}
