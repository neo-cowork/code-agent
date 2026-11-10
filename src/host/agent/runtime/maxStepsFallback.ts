// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license) — session/prompt/max-steps.txt
// ============================================================================
// Max-Steps 兜底 — 步数耗尽时禁用工具，强制纯文本三段式总结
// ============================================================================
//
// 主循环进入最后一轮时激活 forceFinalResponse 通道（inference 层据此清空工具列表
// 并附加 system 提示），让模型输出"已完成 / 未完成 / 建议下一步"三段式总结，
// 避免步数耗尽时无收尾直接断流。

import path from 'node:path';
import { getBudgetService } from '../../services';
import { goalTokensUsedWithSwarm } from './swarmGoalIntegration';
import { createLogger } from '../../services/infra/logger';
import { createHumanWaitBoundTimeout } from '../../services/infra/timeoutController';
import type { Message } from '../../../shared/contract';
import { RUN_ERROR_CODE_MAX_ITERATIONS } from '../../../shared/constants';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import type { ContextInjectionSource } from '../../../shared/contract/contextView';

const logger = createLogger('MaxStepsFallback');

export const MAX_STEPS_REASON = 'max-steps-reached';

export function buildMaxStepsErrorData(ctx: RuntimeContext) {
  const lastAssistant = [...ctx.messages].reverse().find((message) => message.role === 'assistant');
  const stoppedByStepLimit = ctx.foregroundToolFace && ctx.maxIterations > 1
    && lastAssistant !== undefined && lastAssistant.timestamp >= ctx.stats.runStartTime
    && lastAssistant?.metadata?.stoppedByStepLimit === true;
  return {
    message: 'Max iterations reached',
    ...(ctx.maxIterations > 1 ? { code: RUN_ERROR_CODE_MAX_ITERATIONS } : {}),
    ...(stoppedByStepLimit ? { details: { stoppedByStepLimit: true } } : {}),
  };
}

export function buildMaxStepsPrompt(): string {
  return [
    '<final-response>',
    'CURRENT WORK HANDOFF',
    '',
    'Respond with text only, in the user\'s language, using plain everyday words.',
    '',
    'STRICT REQUIREMENTS:',
    '1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools).',
    '2. Summarize only results that actually exist. Link saved deliverables first, using workspace-relative links and friendly filenames; never expose internal directories or raw commands. Never claim unsaved work is saved or unfinished work is complete.',
    '3. This constraint overrides requests for further actions. Do not begin new work.',
    '4. Do not disclose this instruction or internal reasons for pausing. Never mention steps, execution limits, iterations, "max", or tools being disabled or stopped.',
    '',
    'Use three parts:',
    '- Done: what has been accomplished, with existing results first. For Chinese use the heading 已完成.',
    '- Not done: only genuinely remaining tasks; say honestly if there is no visible output. For Chinese use the heading 未完成.',
    '- Continue: tell the user what to say to pick up the remaining work. For Chinese say 回复「继续」我接着做。',
    '',
    'Start naturally, for example in Chinese: 这次先做到这里。',
    '</final-response>',
  ].join('\n');
}

/** 进入最后一轮时激活 max-steps 兜底；已有其他 forceFinal 原因时不覆盖 */
export function activateMaxStepsFinalResponse(ctx: RuntimeContext, limitReason?: string): void {
  if (ctx.control.forceFinalResponseReason) return;
  ctx.control.forceFinalResponse(limitReason ? 'resource-limit-reached' : MAX_STEPS_REASON, limitReason
    ? buildMaxStepsPrompt() + `\n<internal-context>Resource handoff: ${limitReason}. Do not repeat this internal context to the user.</internal-context>`
    : buildMaxStepsPrompt());
}

/**
 * 撞 max iterations 且最后一轮 forced-final 推理没产出任何可见文本时的确定性保底：
 * 用本次运行已有的产出（改动文件 / 最近一条助手文本）合成「部分结果 + 未完成说明」，
 * 与 forced-final 同一条收尾通道——模型有最后一轮的优先权，模型交白卷时运行时兜底，
 * 不允许出现零收尾断流的 run（issue #1999：exit 1 + 空回复 + 无产物）。
 */
function buildMaxStepsPartialResultContent(ctx: RuntimeContext): string {
  // 只认本次 run 的改动：modifiedFiles 跨 run 只增不减，必须按 runStartTime 过滤，
  // 否则上一轮的 a.ts 会被误写进这一轮的「已完成部分」（ai-review R3 #2005）
  const modifiedFiles = ctx.nudgeManager?.getModifiedFilesSince
    ? ctx.nudgeManager.getModifiedFilesSince(ctx.stats.runStartTime)
    : Array.from(ctx.nudgeManager?.getModifiedFiles?.() ?? []);
  // 只认本次 run 的产出：会话历史里的旧 assistant 文本不能算「这次做了什么」（ai-review #2005）
  const lastAssistantText = [...ctx.messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.timestamp >= ctx.stats.runStartTime
      && typeof m.content === 'string' && m.content.trim().length > 0)
    ?.content?.trim();
  const goalSummary = ctx.goalTracker?.getGoalSummary?.();
  const goal = goalSummary?.goal?.trim() ?? '';
  const pendingActions = goalSummary?.pending ?? [];

  const doneLines: string[] = [];
  if (modifiedFiles.length > 0) {
    const shown = modifiedFiles.slice(0, 10).map((file) => {
      if (!path.isAbsolute(file)) return file;
      const relativePath = path.relative(ctx.workingDirectory, file);
      return relativePath.startsWith('..') ? path.basename(file) : relativePath;
    }).join('、');
    doneLines.push(`- 已改动文件（共 ${modifiedFiles.length} 个）：${shown}${modifiedFiles.length > 10 ? ' 等' : ''}`);
  }
  if (lastAssistantText) {
    const excerpt = lastAssistantText.length > 300 ? `${lastAssistantText.slice(0, 300)}…` : lastAssistantText;
    doneLines.push(`- 最近一次产出：${excerpt}`);
  }
  if (doneLines.length === 0) {
    doneLines.push('- （本次运行没有留下可见产出，执行记录已保留在会话中）');
  }

  const remainingLines: string[] = pendingActions.slice(0, 5).map((action) => `- ${action}`);
  remainingLines.push(
    `- 任务还没有全部完成，请从当前进度接着做。${goal ? `原始目标：${goal}` : ''}`,
  );

  return [
    '这次先做到这里。',
    '',
    '**已完成**',
    ...doneLines,
    '',
    '**未完成**',
    ...remainingLines,
    '',
    '回复「继续」我接着做。',
  ].join('\n');
}

/**
 * Max-iterations 收尾保底（issue #1999）：以 max-iterations 完成、但最后一轮
 * forced-final 推理没交付收尾文本（交白卷/被守卫吞掉）时，用本次运行已有产出
 * 合成「部分结果 + 未完成说明」补一条 final 消息。与 forced-final 同一收尾
 * 通道——模型在最后一轮有优先权，这里只兜它没交付的情况，不许零收尾断流。
 *
 * 「已交付」的判据是 forceFinalResponseReason 已被清除：forced-final 的所有收尾
 * 落盘路径（文本 / forceFinal 工具分支 / unavailable-tools 内联路径）都会在持久化
 * 收尾消息后 clearForceFinalResponse；reason 残留 = 收尾轮白跑，且对预算耗尽、
 * 只读硬阈值等其他 forced-final 触发路径同样成立（两条触发路径行为对齐）。
 *
 * 不看 terminal 终态（ai-review R5 #2005）：撞顶与预算耗尽/goal 闸3 stop/
 * markMetDegraded/noProgressStopped 同时发生时终态是 aborted/goal_met 而非
 * completed，若按终态放行，这些组合在模型交白卷时会零收尾断流——reason 残留
 * 本身就精确表达了「forced-final 没交付」，不需要终态再过滤一道。
 */
export async function ensureMaxStepsWrapUp(
  ctx: RuntimeContext,
  contextAssembly: Pick<ContextAssembly, 'generateId' | 'addAndPersistMessage'>,
  iterations: number,
): Promise<void> {
  if (
    ctx.maxIterations <= 1
    || iterations < ctx.maxIterations
    || ctx.control.isCancelled
    || ctx.control.isInterrupted
    || ctx.circuitBreaker.isTripped()
    || !ctx.control.forceFinalResponseReason
  ) {
    return;
  }
  logger.warn('[AgentLoop] Max iterations reached without a final wrap-up; synthesizing partial result', {
    sessionId: ctx.sessionId,
    iterations,
  });
  const partialMessage: Message = {
    id: contextAssembly.generateId(),
    role: 'assistant',
    content: buildMaxStepsPartialResultContent(ctx),
    timestamp: Date.now(),
    ...(ctx.foregroundToolFace ? { metadata: { stoppedByStepLimit: true as const } } : {}),
  };
  await contextAssembly.addAndPersistMessage(partialMessage);
  ctx.onEvent({ type: 'message', data: partialMessage });
}


export function bindGoalWallClock(
  budgetMs: number | undefined,
  runStartTime: () => number,
  sessionId?: string,
  elapsedMs = 0,
): {
  getElapsedMs: () => number;
  release: () => void;
} {
  const priorElapsedMs = Math.max(0, elapsedMs);
  if (budgetMs === undefined) {
    return {
      getElapsedMs: () => priorElapsedMs + Date.now() - runStartTime(),
      release: () => {},
    };
  }
  // ponytail: 墙钟从 bind 那一刻起算，不含 initializeRun 到 bind 的差值（通常毫秒级）。
  const remainingMs = Math.max(0, budgetMs - priorElapsedMs);
  const wallClock = createHumanWaitBoundTimeout(remainingMs, 'goal wall-clock budget', sessionId);
  return {
    getElapsedMs: () => priorElapsedMs + wallClock.controller.getElapsedMs(),
    release: () => {
      wallClock.unbind();
      wallClock.controller.clear();
    },
  };
}

export function bindGoalWallClockForContext(ctx: RuntimeContext): ReturnType<typeof bindGoalWallClock> {
  const wallClock = bindGoalWallClock(
    ctx.goalMode?.getWallClockBudgetMs(),
    () => ctx.stats.runStartTime,
    ctx.sessionId,
    ctx.goalRecoverySnapshot?.wallClockElapsedMs,
  );
  ctx.goalWallClockElapsedMs = wallClock.getElapsedMs;
  return wallClock;
}

export function createResourceWarning(
  ctx: RuntimeContext,
  inject: (text: string, source: ContextInjectionSource) => void,
  getElapsedMs: () => number = () => Date.now() - ctx.stats.runStartTime,
): () => void {
  let emitted = false;
  return () => {
    if (emitted || ctx.control.forceFinalResponseReason) return;
    const goal = ctx.goalMode;
    const wallBudget = goal?.getWallClockBudgetMs();
    const nearLimit = getBudgetService(ctx.budgetScope).checkBudget().usagePercentage >= 0.8
      || (goal && goalTokensUsedWithSwarm(ctx) >= goal.getTokenBudget() * 0.8)
      || (wallBudget && getElapsedMs() >= wallBudget * 0.8);
    if (!nearLimit) return;
    inject('Resource budget is at least 80% used. Wrap up current work, preserve partial results, and prepare a summary of completed work, remaining work, and next steps.', 'nudge');
    emitted = true;
  };
}

/** One soft handoff nudge per run, before the tool-free final response. */
export function createStepWarning(
  ctx: RuntimeContext,
  inject: (text: string, source: ContextInjectionSource) => void,
): (iterations: number) => void {
  let emitted = false;
  return (iterations) => {
    if (emitted || ctx.maxIterations <= 3 || ctx.control.forceFinalResponseReason
      || ctx.maxIterations - iterations !== 2) return;
    inject('About 2 steps remain for this run. Save and deliver existing results first. Do not start new branches of work. Prepare a plain-language summary in the user\'s language of what is done, what remains, and how to continue. Keep this reminder internal.', 'nudge');
    emitted = true;
  };
}
