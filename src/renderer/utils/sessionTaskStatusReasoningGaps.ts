import type { TraceNode } from '@shared/contract/trace';
import { readSessionTask } from './sessionTaskPresentation';

/** Only identical status reads may bridge pure reasoning; keep the original nodes
 * reachable through TurnCard's thinking digest and leave every other boundary alone. */
export function sessionTaskStatusReasoningGaps(nodes: readonly TraceNode[]): ReadonlySet<TraceNode> {
  const gaps = new Set<TraceNode>();
  let previousKey: string | null = null;
  let reasoning: TraceNode[] = [];
  for (const node of nodes) {
    if (node.type === 'assistant_text' && !node.content.trim()
      && Boolean(node.thinking?.trim() || node.reasoning?.trim())
      && !node.subtype && !node.attachments?.length && !node.artifacts?.length
      && !node.modelDecision && !node.turnTimeline
      && !node.metadata?.agentError && !node.metadata?.streamRecovery
      && !node.metadata?.streamInterruptionReason) {
      reasoning.push(node);
      continue;
    }
    const tc = node.type === 'tool_call' ? node.toolCall : undefined;
    const payload = tc?.name === 'task_status' && tc.result !== undefined && tc.success !== false
      ? readSessionTask(tc.metadata) : null;
    const key = payload?.outcome === 'status' ? JSON.stringify(payload) : null;
    if (key !== null && key === previousKey) {
      for (const gap of reasoning) gaps.add(gap);
    }
    previousKey = key;
    reasoning = [];
  }
  return gaps;
}
