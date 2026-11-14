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

const logger = createLogger('AgentLoop');

export interface ForegroundShellDenial {
  guidance: string;
  finalMessage: string;
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
    guidance: 'The requested operation was NOT run. Follow the accompanying next-action guidance '
      + 'and use its everyday handoff sentence as the complete reply after acceptance.',
    finalMessage: '本轮前台不直接执行 Shell 命令（Bash），命令没有运行。可以让我把它交给后台代理执行，届时会按你的权限规则询问你。',
  };
}
