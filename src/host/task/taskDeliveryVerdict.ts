import type { Message } from '../../shared/contract';
import { getToolResolver } from '../tools/dispatch/toolResolver';

export function isTaskDeliveryFailed(
  messages: readonly Message[],
  deliverableArtifactCount: number,
): boolean {
  const toolNamesByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) toolNamesByCallId.set(call.id, call.name);
  }

  let outputSucceeded = false;
  let outputFailed = false;
  const resolver = getToolResolver();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      const toolName = toolNamesByCallId.get(result.toolCallId);
      if (!toolName || resolver.getDefinition(toolName)?.permissionLevel !== 'write') continue;
      if (result.success) outputSucceeded = true;
      else outputFailed = true;
    }
  }

  return outputFailed && !outputSucceeded && deliverableArtifactCount === 0;
}
