import type { Message, ToolResult } from '../../shared/contract';
import { HostReasonCode } from '../../shared/contract/permission';
import type { SessionTaskDeliveryFailure } from '../../shared/constants/sessionCommandCenter';
import { getToolResolver } from '../tools/dispatch/toolResolver';

export type TaskDeliveryFailure = SessionTaskDeliveryFailure | 'write_failed' | 'user_denied';

function terminalDeliveryFailure(messages: readonly Message[]): SessionTaskDeliveryFailure | undefined {
  let lastResult: ToolResult | undefined;
  for (const message of messages) {
    for (const result of message.toolResults ?? []) lastResult = result;
  }
  if (!lastResult || lastResult.success) return undefined;
  if (lastResult.metadata?.repairExhausted === true) return 'repair_exhausted';
  const hostReason = lastResult.metadata?.hostReason as { code?: unknown } | undefined;
  if (hostReason?.code === HostReasonCode.PermissionDeniedTimeout) return 'approval_timeout';
  return undefined;
}

export function getTaskDeliveryFailure(
  messages: readonly Message[],
  deliverableArtifactCount: number,
): TaskDeliveryFailure | undefined {
  const terminalFailure = terminalDeliveryFailure(messages);
  if (terminalFailure && deliverableArtifactCount === 0) return terminalFailure;

  const toolNamesByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) toolNamesByCallId.set(call.id, call.name);
  }

  let outputSucceeded = false;
  let outputFailed = false;
  let outputDeniedByUser = false;
  const resolver = getToolResolver();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      const toolName = toolNamesByCallId.get(result.toolCallId);
      if (!toolName) continue;
      const permissionLevel = resolver.getDefinition(toolName)?.permissionLevel;
      const isWrite = permissionLevel === 'write';
      if (!isWrite && permissionLevel !== 'execute') continue;
      const hostReason = result.metadata?.hostReason as { code?: unknown } | undefined;
      const deniedByUser = hostReason?.code === HostReasonCode.PermissionDeniedByUser;
      if (result.success) outputSucceeded = true;
      else if (deniedByUser) {
        outputFailed = true;
        outputDeniedByUser = true;
      } else if (isWrite) outputFailed = true;
    }
  }

  if (!outputFailed || outputSucceeded || deliverableArtifactCount > 0) return undefined;
  return outputDeniedByUser ? 'user_denied' : 'write_failed';
}
