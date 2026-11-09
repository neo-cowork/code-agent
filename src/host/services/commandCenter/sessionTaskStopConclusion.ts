// ============================================================================
// 后台会话任务（delegate_task）没做完就停下时，对话里要留一句白话结论
// （N-FIX-BROWSER-TASK-CONTEXT-BLOAT-SILENT-END）。
// 真正会开浏览器的后台任务走完整 AgentLoop，终态只有 task_completed / task_error 两种事件：
//   - 撞步数上限：主循环最后一轮由模型自己写收尾（措辞不固定），终态仍写「completed」；
//   - 最后一轮只有工具调用没有文字：conclusion 为空，旧文案写「任务已完成。」——撒谎；
//   - 中途报错：detail 是原始（常为英文）异常文本。
// 这里只做确定性改写，不多调一次模型；主循环 maxStepsFallback 不动。
// ============================================================================

import { AgentFailureCode, inferAgentFailureCode } from '../../../shared/contract/agentFailure';
import { describeSubagentStopReason } from '../../agent/subagentFailureReason';

export type StoppedTaskStatus = 'completed' | 'failed';

export interface StoppedTaskOutcome {
  status: StoppedTaskStatus;
  detail: string;
  /** 没做完就停下时给用户看的那一句（确定性、不依赖模型转述）；正常结束为 undefined。 */
  notice?: string;
}

function pageClause(lastUrl: string | undefined): string {
  return lastUrl ? `最后停留在页面${lastUrl}，` : '';
}

/** 无需改写（已完成且有正常结论 / 已是白话失败说明）时原样返回。 */
export function resolveStoppedTaskOutcome(input: {
  status: StoppedTaskStatus;
  detail: string | undefined;
  lastUrl?: string;
  /** 主循环撞步数上限（结构化信号：error 事件 code=MAX_ITERATIONS_REACHED）；max 为该任务实际生效的上限。 */
  stepCap?: { max: number };
}): StoppedTaskOutcome {
  const detail = input.detail?.trim() ?? '';
  if (input.status === 'completed') {
    if (input.stepCap) {
      const max = input.stepCap.max;
      const head = `后台任务做到第 ${max} 步（上限 ${max} 步）就用完了步数，${pageClause(input.lastUrl)}还没有得出最终结果。你可以回复「继续」让它接着做，或者把任务缩小一些（比如只看其中一个网站）再试一次。`;
      return { status: 'failed', detail: detail ? `${head}\n\n它停下前留下的说明：${detail}` : head, notice: head };
    }
    if (!detail) {
      const notice = `后台任务停下来了，${pageClause(input.lastUrl)}但没有留下最终结果。你可以回复「继续」让它接着做，或者把任务缩小一些（比如只看其中一个网站）再试一次。`;
      return { status: 'failed', detail: notice, notice };
    }
    return { status: 'completed', detail };
  }
  const code = inferAgentFailureCode({ error: detail, defaultCode: AgentFailureCode.Unknown });
  const reason = describeSubagentStopReason(detail || '执行失败', code);
  const failedDetail = input.lastUrl && reason === detail
    ? `${detail}（${pageClause(input.lastUrl).replace(/，$/, '')}）`
    : reason;
  return { status: 'failed', detail: failedDetail, notice: failedDetail };
}
