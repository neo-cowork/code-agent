import * as os from 'os';
import type { Message, ToolResult } from '../../shared/contract';
import { HostReasonCode } from '../../shared/contract/permission';
import type { SessionTaskDeliveryFailure } from '../../shared/constants/sessionCommandCenter';
import { compileReadOnlyProbePlan } from '../security/readOnlyProbePlan';
import { getToolResolver } from '../tools/dispatch/toolResolver';
import { isBashToolName } from '../tools/toolNames';

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

/**
 * 证明得了只读的 Bash 成功不算执行进展。
 * 命令缺失或不是字符串时无法证明只读；文法认不出或 win32 时编译返回 null。两种都仍算进展。
 */
function bashExecuteSuccessCounts(command: unknown): boolean {
  if (typeof command !== 'string') return true;
  return compileReadOnlyProbePlan(command, { homeDir: os.homedir(), platform: process.platform }) === null;
}

export function getTaskDeliveryFailure(
  messages: readonly Message[],
  deliverableArtifactCount: number,
): TaskDeliveryFailure | undefined {
  const terminalFailure = terminalDeliveryFailure(messages);
  if (terminalFailure && deliverableArtifactCount === 0) return terminalFailure;

  const toolCallsById = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      toolCallsById.set(call.id, { name: call.name, arguments: call.arguments });
    }
  }

  let writeSucceeded = false;
  let executeSucceeded = false;
  let writeFailed = false;
  let writeDeniedByUser = false;
  let executeDeniedByUser = false;
  const resolver = getToolResolver();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      const call = toolCallsById.get(result.toolCallId);
      if (!call) continue;
      const toolName = call.name;
      const permissionLevel = resolver.getDefinition(toolName)?.permissionLevel;
      const isWrite = permissionLevel === 'write';
      if (!isWrite && permissionLevel !== 'execute') continue;
      if (result.success) {
        if (isWrite) writeSucceeded = true;
        else if (!isBashToolName(toolName) || bashExecuteSuccessCounts(call.arguments?.command)) executeSucceeded = true;
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
  // 仅被拒的执行类工具：之后认不出只读的成功执行才算有进展。证明只读的 Bash 不救。
  if (executeDeniedByUser && !executeSucceeded) return 'user_denied';
  return undefined;
}
