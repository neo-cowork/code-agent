// ============================================================================
// Bash 被本轮工具面收掉时的可见交代（N-FIX-NL-RULE-ASK-BASH-SILENT-ABORT）
// ============================================================================
// 文字前台（ADR-059）工具面不含 Bash：模型直接调 Bash 会走 TOOL_DISABLED_FOR_RUN，
// 用户保存的「rm 先问我」规则连审批卡都到不了——表现为无卡、无 pending、模型回
// 「Bash is disabled」，用户看到一个无原因的中断。这里保证这条路径一定：
// ① warn 日志带可区分原因（工具不在本轮工具面 / 是否存在用户 Bash 规则）；
// ② 给模型一句不再死路重试的指引；③ 超过重试上限时给用户一句人话终态。

import type { ToolCall } from '../../../shared/contract';
import { resolveEffectivePolicyRules } from '../../permissions/runPolicySnapshot';
import { createLogger } from '../../services/infra/logger';
import { isBashToolName } from '../../tools/toolNames';
import type { RuntimeContext } from './runtimeContext';
import { isToolDeniedForRun } from './toolRunPolicy';
import { getToolAttemptTrace } from './toolAttemptTrace';

const logger = createLogger('AgentLoop');

export interface ForegroundShellDenial {
  guidance: string;
  finalMessage: string;
}

function latestUserPrompt(ctx: RuntimeContext): string {
  return [...(ctx.messages ?? [])].reverse().find((message) => message.role === 'user')?.content ?? '';
}

export function summarizeForegroundShellRequest(userPrompt: string): {
  title: string;
  shortName: string;
  userMessage: string;
} {
  const normalized = userPrompt.replace(/\s+/g, ' ').trim();
  const methodPattern = /(?:请|麻烦|我想)?\s*(?:用|使用|通过)?\s*(?:\b(?:Bash|terminal|shell|osascript|heredoc|command)\b|命令行|终端)(?:\s*工具)?/i;
  const methodMatch = normalized.match(methodPattern);
  const beforeMethod = methodMatch?.index === undefined ? '' : normalized.slice(0, methodMatch.index);
  const afterMethod = methodMatch?.index === undefined
    ? normalized
    : normalized.slice(methodMatch.index + methodMatch[0].length);
  const candidate = (beforeMethod || afterMethod)
    .split(/[。！？\n]/, 1)[0]
    .replace(/\s*[:：].*$/, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\([^)]*(?:heredoc|command|osascript)[^)]*\)/gi, '')
    .replace(/\b(?:Bash|terminal|shell|osascript|heredoc|command|npm|npx|vitest|typecheck)\b|命令行|终端|工具/gi, '')
    .replace(/^\s*(?:请|麻烦)?\s*(?:帮我|帮忙)?\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/[“”"']/g, '')
    .trim()
    .replace(/[。！？；;，,]+$/, '');
  const hasChinese = /[\u3400-\u9fff]/.test(candidate);
  const looksLikeShellCommand = !hasChinese && (/[|&;/<>$]/.test(candidate) || /^\S+(?:\s+-\w+)+$/.test(candidate));
  const title = Array.from(looksLikeShellCommand ? '' : candidate).slice(0, 24).join('') || '处理后台任务';
  const shortName = Array.from(title.replace(/\s+/g, '')).slice(0, 4).join('') || '任务';
  return { title, shortName, userMessage: title };
}

/** 把前台误发的 Bash 调用改成唯一可用的后台委托入口，避免模型先撞禁用工具。 */
export function redirectDeniedShellCalls(
  ctx: RuntimeContext,
  toolCalls: readonly ToolCall[],
): ToolCall[] {
  if (ctx.foregroundToolFace !== true || isToolDeniedForRun(ctx, 'delegate_task')) return [...toolCalls];
  const shellCalls = toolCalls.filter((call) => isBashToolName(call.name));
  if (shellCalls.length === 0) return [...toolCalls];

  const laneKey = `foreground-shell:${ctx.runId || ctx.turn?.currentTurnId || ctx.sessionId}`;
  const userPrompt = ctx.turn?.runUserPrompt || latestUserPrompt(ctx);
  const summary = summarizeForegroundShellRequest(userPrompt);
  const rewritten = shellCalls.map((call) => ({
    ...call,
    name: 'delegate_task',
    arguments: {
      title: summary.title,
      short_name: summary.shortName,
      lane_key: laneKey,
      submission_key: laneKey,
      prompt: `${userPrompt}\n\nCommand to run:\n${typeof call.arguments.command === 'string' ? call.arguments.command : ''}`,
    },
  }));
  const skippedCalls = toolCalls.filter((call) => !isBashToolName(call.name));
  for (const call of skippedCalls) {
    getToolAttemptTrace(ctx).begin(call);
    getToolAttemptTrace(ctx).finish(call, {
      toolCallId: call.id,
      success: false,
      error: 'TOOL_BATCH_SKIPPED',
      duration: 0,
      metadata: { skipped: true },
    }, false, 0);
  }
  logger.info('Foreground shell call redirected to background task', {
    cause: 'foreground-shell-redirected',
    sessionId: ctx.sessionId,
    callCount: rewritten.length,
    skippedCount: skippedCalls.length,
  });
  return rewritten;
}

export function describeDeniedShellCalls(
  ctx: RuntimeContext,
  deniedToolCalls: readonly Pick<ToolCall, 'name'>[],
): ForegroundShellDenial | undefined {
  if (!deniedToolCalls.some((call) => isBashToolName(call.name))) return undefined;
  const userBashRules = resolveEffectivePolicyRules(ctx.sessionId)
    .filter((rule) => rule.id.startsWith('user-') && rule.matcher.tool !== undefined && isBashToolName(String(rule.matcher.tool)));
  logger.warn('Bash call dropped before approval: tool not in this turn\'s tool face', {
    cause: 'tool-not-in-run-toolset',
    sessionId: ctx.sessionId,
    userBashRules: userBashRules.map((rule) => rule.id),
  });
  return {
    guidance: 'The requested shell command is not available in this foreground turn, so the command was NOT run. '
      + 'Do not retry it. Continue with the tools available in this turn and tell the user plainly what was not run.',
    finalMessage: '本轮前台不直接执行 Shell 命令（Bash），命令没有运行。可以让我把它交给后台代理执行，届时会按你的权限规则询问你。',
  };
}
