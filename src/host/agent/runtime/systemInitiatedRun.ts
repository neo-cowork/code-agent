// ============================================================================
// SystemInitiatedRun — 带 terminalErrorSink 的系统发起 run（后台完成唤醒等）终态 error 的唯一出口。
//
// 不变量：调用方显式声明由自己接管失败（传了 sink）的 run，终态 error 不得作为 agent `error`
// 事件投给会话前端（渲染端据此挂失败卡、标红点），只交给 sink。
// 没传 sink 的 run（含 meta 输入，如 roleFirstWake / meetingMinutes）不拦截：RunFinalizer 的
// RUN_FAILED / 步数超限只发事件不抛异常，事件是它们唯一的失败通道（鉴权/余额失败卡靠它）。
// 各生产者都经 orchestrator 的 sessionAwareOnEvent 汇到这里。
// ============================================================================

import type { AgentEvent } from '../../../shared/contract';
import type { AgentRunOptions } from '../../research/types';
import { isTerminalAgentError } from '../../../shared/utils/agentErrorClassification';

/** 返回 true 表示该事件已交给调用方的 sink，不得再向会话前端投递。 */
export function consumeSystemRunTerminalError(
  options: Pick<AgentRunOptions, 'terminalErrorSink'> | undefined,
  event: AgentEvent,
): boolean {
  if (event.type !== 'error' || !options?.terminalErrorSink || !isTerminalAgentError(event.data)) return false;
  options.terminalErrorSink(event.data);
  return true;
}
