// ============================================================================
// 后台会话任务（delegate_task）没做完就停下时，对话里要留一句白话结论
// （N-FIX-BROWSER-TASK-CONTEXT-BLOAT-SILENT-END）。
// 真正会开浏览器的后台任务走完整 AgentLoop，终态只有 task_completed / task_error 两种事件：
//   - 撞步数上限：主循环最后一轮由模型自己写收尾（措辞不固定），终态仍写「completed」；
//   - 最后一轮只有工具调用没有文字：conclusion 为空，旧文案写「任务已完成。」——撒谎；
//   - 结论只剩工具调用标记（剥掉后没有正文）：同样没有可用结果，不能因为标记非空就算完成；
//   - 中途报错：detail 是原始（常为英文）异常文本。
// 这里只做确定性改写，不多调一次模型；主循环 maxStepsFallback 不动。
// ============================================================================

import { AgentFailureCode, inferAgentFailureCode } from '../../../shared/contract/agentFailure';
import type { MessageMetadata } from '../../../shared/contract';
import { stripCardToolCallMarkup } from '../../../shared/modelMarkupStrip';
import { describeSubagentStopReason } from '../../agent/subagentFailureReason';
import { formatSessionTaskDeliveryFailure } from '../../../shared/constants/sessionCommandCenter';

type StoppedTaskStatus = 'completed' | 'failed';

interface StoppedTaskOutcome {
  status: StoppedTaskStatus;
  detail: string;
  /** 没做完就停下时给用户看的那一句（确定性、不依赖模型转述）；正常结束为 undefined。 */
  notice?: string;
  kind?: NonNullable<MessageMetadata['backgroundTaskStopped']>['kind'];
}

/** 结论开头就承认没做成的措辞（封闭列表）。只认第一行行首，正文后面再出现不算。 */
const UNFINISHED_OPENERS = [
  '任务未完成', '任务未能完成', '任务没能完成', '任务无法完成', '任务没有完成', '任务失败', '任务执行失败', '未能完成', '没能完成', '没有完成', '无法完成', '执行失败',
  '无法打开', '页面打不开', '打不开', '没能取到', '未能获取', '无法获取', '未能取到',
] as const;
const UNFINISHED_OPENERS_EN = /^(?:unable to|could not|couldn't|failed to|cannot|can't)\b/i;
const UNFINISHED_NOTICE = '这个后台任务没有完成你交代的事，下面是它留下的说明：';

function opensWithUnfinished(conclusion: string): boolean {
  const first = conclusion.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const head = first
    .replace(/^(?:[>#*_`\-+\s]|\d+[.)、]\s*)+/, '')
    .replace(/^(?:结论|结果|总结|说明)\s*[:：]\s*/, '')
    .replace(/^[*_`\s]+/, '');
  return UNFINISHED_OPENERS.some((opener) => head.startsWith(opener)) || UNFINISHED_OPENERS_EN.test(head);
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
  const raw = input.detail?.trim() ?? '';
  if (input.status === 'completed') {
    // 可用结论看剥掉工具调用标记之后的正文。只剩标记时与空结论同一句。
    const detail = stripCardToolCallMarkup(raw);
    if (input.stepCap) {
      const max = input.stepCap.max;
      const head = `后台任务做到第 ${max} 步（上限 ${max} 步）就用完了步数，${pageClause(input.lastUrl)}还没有得出最终结果。你可以回复「继续」让它接着做，或者把任务缩小一些（比如只看其中一个网站）再试一次。`;
      return { status: 'failed', detail: detail ? `${head}\n\n它停下前留下的说明：${detail}` : head, notice: head, kind: 'step_cap' };
    }
    if (!detail) {
      const notice = `后台任务停下来了，${pageClause(input.lastUrl)}但没有留下最终结果。你可以回复「继续」让它接着做，或者把任务缩小一些（比如只看其中一个网站）再试一次。`;
      return { status: 'failed', detail: notice, notice, kind: 'no_conclusion' };
    }
    if (opensWithUnfinished(detail)) {
      const notice = `${UNFINISHED_NOTICE}\n\n${detail}`;
      return { status: 'failed', detail: notice, notice, kind: 'error' };
    }
    return { status: 'completed', detail };
  }
  const detail = raw;
  const isTerminalDeliveryFailure = (['approval_timeout', 'repair_exhausted'] as const).some((reason) => (
    (['zh', 'en'] as const).some((locale) => formatSessionTaskDeliveryFailure(reason, locale) === detail)
  ));
  if (isTerminalDeliveryFailure) return { status: 'failed', detail, notice: detail, kind: 'error' };
  const code = inferAgentFailureCode({ error: detail, defaultCode: AgentFailureCode.Unknown });
  const reason = describeSubagentStopReason(detail || '执行失败', code);
  const failedDetail = input.lastUrl ? `${reason} 最后停留在页面${input.lastUrl}。` : reason;
  return { status: 'failed', detail: failedDetail, notice: failedDetail, kind: 'error' };
}
