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

  let writeSucceeded = false;
  let executeSucceeded = false;
  let writeFailed = false;
  let writeDeniedByUser = false;
  let executeDeniedByUser = false;
  const resolver = getToolResolver();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      const toolName = toolNamesByCallId.get(result.toolCallId);
      if (!toolName) continue;
      const permissionLevel = resolver.getDefinition(toolName)?.permissionLevel;
      const isWrite = permissionLevel === 'write';
      if (!isWrite && permissionLevel !== 'execute') continue;
      if (result.success) {
        if (isWrite) writeSucceeded = true;
        else executeSucceeded = true;
        continue;
      }
      const hostReason = result.metadata?.hostReason as { code?: unknown } | undefined;
      const deniedByUser = hostReason?.code === HostReasonCode.PermissionDeniedByUser;
      if (isWrite) {
        writeFailed = true;
        if (deniedByUser) writeDeniedByUser = true;
      } else if (deniedByUser) executeDeniedByUser = true;
    }
  }

  if (deliverableArtifactCount > 0 || writeSucceeded) return undefined;
  // 写失败语义与原来一致：只有成功的写（或交付产物）能救；执行类成功不救。
  if (writeFailed) return writeDeniedByUser ? 'user_denied' : 'write_failed';
  // 仅被拒的执行类工具：之后任何成功的执行调用都算任务有进展。
  if (executeDeniedByUser && !executeSucceeded) return 'user_denied';
  return undefined;
}
