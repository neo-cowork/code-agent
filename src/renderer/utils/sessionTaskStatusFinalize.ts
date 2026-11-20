import type { Message, ToolCall } from '@shared/contract';
import { readSessionTask } from './sessionTaskPresentation';

export function finalizeSessionTaskStatus(toolCall: ToolCall, messages: readonly Message[]): ToolCall {
  const result = toolCall.result;
  if (toolCall.name !== 'task_status' || !result?.success) return toolCall;

  const sessionTask = readSessionTask(result.metadata);
  if (sessionTask?.outcome !== 'status') return toolCall;

  const pollIndex = messages.findIndex((message) => message.toolCalls?.some((call) => call.id === toolCall.id));
  if (pollIndex === -1) return toolCall;

  const laterMessages = messages.slice(pollIndex + 1);
  let changed = false;
  const tasks = sessionTask.tasks.map((task) => {
    if (task.status !== 'queued' && task.status !== 'running' && task.status !== 'cancelling') return task;

    // The first matching result belongs to this attempt, even when it is unverified.
    const finalResult = laterMessages.find((message) =>
      message.metadata?.backgroundTaskResult?.shortName === task.shortName,
    )?.metadata?.backgroundTaskResult;
    if (!finalResult || finalResult.status === 'unverified') return task;

    changed = true;
    return { shortName: task.shortName, status: finalResult.status };
  });

  if (!changed) return toolCall;
  return {
    ...toolCall,
    result: { ...result, metadata: { ...result.metadata, sessionTask: { ...sessionTask, tasks } } },
  };
}
