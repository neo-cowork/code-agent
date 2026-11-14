import type { ToolCall } from '@shared/contract';
import { readSessionTask } from './sessionTaskPresentation';

/** Presentation only: preserve the original calls and their model-visible results. */
export function foldSessionTaskStatus(toolCalls: readonly ToolCall[]): {
  toolCall: ToolCall;
  count: number;
}[] {
  const groups: { toolCall: ToolCall; count: number }[] = [];
  let previousKey: string | null = null;
  for (const toolCall of toolCalls) {
    const payload = toolCall.name === 'task_status' && toolCall.result?.success === true
      && toolCall.result.output !== undefined
      ? readSessionTask(toolCall.result.metadata)
      : null;
    const key = payload?.outcome === 'status' ? JSON.stringify(payload) : null;
    if (key !== null && key === previousKey) {
      groups[groups.length - 1].count += 1;
    } else {
      groups.push({ toolCall, count: 1 });
    }
    previousKey = key;
  }
  return groups;
}
