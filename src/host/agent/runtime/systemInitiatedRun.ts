// ============================================================================
// SystemInitiatedRun — 系统发起的 run（后台完成唤醒 / meta 输入 / 带 terminalErrorSink）
// 终态 error 的唯一出口。
//
// 不变量：这类 run 的失败不是用户当前请求的失败。终态 error 事件不得作为 agent `error`
// 事件投给会话前端（渲染端据此挂失败卡、标红点），只能走 run 的发起方自己的出口：
// 有 sink 交给 sink（唤醒方记成一句朴素的系统说明）；没有 sink 的 meta 输入，失败仍以
// sendMessage 抛出的异常交给调用方，这里只留一条可区分原因的 warn。
// 各生产者（RunFinalizer / runNormalMode catch / 未来新增者）都经 orchestrator 的
// sessionAwareOnEvent 汇到这里，不再靠逐个生产者打补丁。
// ============================================================================

import type { AgentEvent } from '../../../shared/contract';
import type { AgentRunOptions } from '../../research/types';
import { getAgentErrorMessage, isTerminalAgentError } from '../../../shared/utils/agentErrorClassification';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('SystemInitiatedRun');

type SystemRunOptions = Pick<AgentRunOptions, 'terminalErrorSink' | 'inputHistoryVisibility'>;

/** 返回 true 表示该事件已被系统 run 的出口接管，调用方不得再向会话前端投递。 */
export function consumeSystemRunTerminalError(
  options: SystemRunOptions | undefined,
  event: AgentEvent,
): boolean {
  if (event.type !== 'error') return false;
  if (!options?.terminalErrorSink && options?.inputHistoryVisibility !== 'meta') return false;
  if (!isTerminalAgentError(event.data)) return false;
  if (options.terminalErrorSink) {
    options.terminalErrorSink(event.data);
    return true;
  }
  logger.warn('System-initiated run terminal error withheld from the chat stream; the caller owns the failure', {
    reason: 'system_run_error_without_sink',
    message: getAgentErrorMessage(event.data),
  });
  return true;
}
