import type { TraceNode } from '@shared/contract/trace';
import { isDelegationTool } from '../utils/agentActivity';

type ToolCallNode = NonNullable<TraceNode['toolCall']>;

/** 联网检索类工具：换搜索源/换抓取方式重试是常态恢复模式。 */
function isRetrievalTool(name: string | undefined): boolean {
  if (!name) return false;
  return /web|search|fetch|tavily|exa|perplexity|brave/i.test(name);
}

/**
 * 系统关卡拦下的调用（host 封口行带 metadata.bounced）：用户无法对它采取任何动作，
 * 之后只要这一轮给出了答案就不该再顶红。判据主要是 bounced 标记（真实的 Bash 失败不受影响），
 * 但派发/委托步骤（isDelegationTool）从未真正启动子任务，后续正文或其它成功不能算已恢复。
 */
function isGateBounce(toolCall: ToolCallNode): boolean {
  // A call handed to a background task is not a failure a later success fixed: its state comes from that task.
  // A bounced hand-off tool never ran its delegated work, so later text or other successes do not recover it.
  return toolCall.metadata?.bounced === true
    && toolCall.metadata.code !== 'HANDED_OFF_TO_BACKGROUND'
    && !(toolCall.name && isDelegationTool(toolCall.name));
}

/** 失败的工具调用在「之后出现成功标志」时是否可降级为已恢复。 */
export function isRecoverableAfterLaterSuccess(toolCall: ToolCallNode): boolean {
  return isRetrievalTool(toolCall.name) || isGateBounce(toolCall);
}
