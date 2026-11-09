// ============================================================================
// 后台会话任务（delegate_task）没做完就停下时，对话里要留一句白话结论
// （N-FIX-BROWSER-TASK-CONTEXT-BLOAT-SILENT-END）。
// 真正会开浏览器的后台任务走完整 AgentLoop，终态只有 task_completed / task_error 两种事件：
//   - 撞步数上限：主循环已合成中文收尾，但终态仍写「completed」；
//   - 最后一轮只有工具调用没有文字：conclusion 为空，旧文案写「任务已完成。」——撒谎；
//   - 中途报错：detail 是原始（常为英文）异常文本。
// 这里只做确定性改写，不多调一次模型；主循环 maxStepsFallback 不动。
// ============================================================================

import { AgentFailureCode, inferAgentFailureCode } from '../../../shared/contract/agentFailure';
import { describeSubagentStopReason } from '../../agent/subagentFailureReason';

/** maxStepsFallback.buildMaxStepsPartialResultContent 合成收尾的固定片段（有静态契约测试钉住）。 */
const MAX_STEPS_MARKER = '已达最大执行轮次';

export type StoppedTaskStatus = 'completed' | 'failed';

export interface StoppedTaskOutcome {
  status: StoppedTaskStatus;
  detail: string;
}

function pageClause(lastUrl: string | undefined): string {
  return lastUrl ? `最后停留在页面${lastUrl}，` : '';
}

/** 无需改写（已完成且有正常结论 / 已是白话失败说明）时原样返回。 */
export function resolveStoppedTaskOutcome(input: {
  status: StoppedTaskStatus;
  detail: string | undefined;
  lastUrl?: string;
}): StoppedTaskOutcome {
  const detail = input.detail?.trim() ?? '';
  if (input.status === 'completed') {
    if (!detail) {
      return {
        status: 'failed',
        detail: `后台任务停下来了，${pageClause(input.lastUrl)}但没有留下最终结果。你可以回复「继续」让它接着做，或者把任务缩小一些（比如只看其中一个网站）再试一次。`,
      };
    }
    if (detail.includes(MAX_STEPS_MARKER)) {
      return {
        status: 'failed',
        detail: input.lastUrl ? `${detail}\n\n最后停留在页面${input.lastUrl}。` : detail,
      };
    }
    return { status: 'completed', detail };
  }
  const code = inferAgentFailureCode({ error: detail, defaultCode: AgentFailureCode.Unknown });
  const reason = describeSubagentStopReason(detail || '执行失败', code);
  return {
    status: 'failed',
    detail: input.lastUrl && reason === detail ? `${detail}（${pageClause(input.lastUrl).replace(/，$/, '')}）` : reason,
  };
}
