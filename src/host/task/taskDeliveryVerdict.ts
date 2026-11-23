import * as os from 'os';
import type { Message, ToolResult } from '../../shared/contract';
import { HostReasonCode } from '../../shared/contract/permission';
import type { SessionTaskDeliveryFailure } from '../../shared/constants/sessionCommandCenter';
import { compileReadOnlyProbePlan } from '../security/readOnlyProbePlan';
import { getToolResolver } from '../tools/dispatch/toolResolver';
import { isBashToolName } from '../tools/toolNames';
import { shortenDisplayPaths } from '../agent/workspacePathDisplay';
import { formatSessionTaskCommandFailed } from '../../shared/constants/sessionCommandCenter';

export type TaskDeliveryFailure = SessionTaskDeliveryFailure | 'write_failed' | 'user_denied' | 'command_failed';

const FAILED_COMMAND_MAX_CHARS = 200;
const FAILED_REASON_MAX_CHARS = 120;

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

/** 成功的执行类工具是否算「有进展」：证明得了只读的 Bash 不算。判决与失败文案共用这一条清零规则。 */
function executeSuccessClearsFailure(toolName: string, command: unknown): boolean {
  return !isBashToolName(toolName) || bashExecuteSuccessCounts(command);
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
  let commandFailed = false;
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
        else if (executeSuccessClearsFailure(toolName, call.arguments?.command)) {
          executeSucceeded = true;
          commandFailed = false;
        }
        continue;
      }
      const hostReason = result.metadata?.hostReason as { code?: unknown } | undefined;
      const deniedByUser = hostReason?.code === HostReasonCode.PermissionDeniedByUser;
      if (isWrite) {
        writeFailed = true;
        if (deniedByUser) writeDeniedByUser = true;
      } else if (deniedByUser) executeDeniedByUser = true;
      else if (isBashToolName(toolName) && result.metadata?.code === 'COMMAND_FAILED') commandFailed = true;
    }
  }

  if (deliverableArtifactCount > 0 || writeSucceeded) return undefined;
  // 写失败语义与原来一致：只有成功的写（或交付产物）能救；执行类成功不救。
  if (writeFailed) return writeDeniedByUser ? 'user_denied' : 'write_failed';
  // 仅被拒的执行类工具：之后认不出只读的成功执行才算有进展。证明只读的 Bash 不救。
  if (executeDeniedByUser && !executeSucceeded) return 'user_denied';
  // 最后一条会算进展的执行是失败的 Bash（COMMAND_FAILED），之后没有成功的执行也没有交付物。
  if (commandFailed) return 'command_failed';
  return undefined;
}

/**
 * 最后一条失败的 Bash（COMMAND_FAILED）→ 给用户看的白话句：命令行 + 原因首行。
 * 绝对路径一律缩成 ./相对 或末两段，不外露家目录。
 */
export function describeFailedCommand(
  messages: readonly Message[],
  workspaceRoot: string | undefined,
  locale: 'zh' | 'en',
): string | undefined {
  const callsById = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  const resolver = getToolResolver();
  let failed: { command: string; result: ToolResult } | undefined;
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      callsById.set(call.id, { name: call.name, arguments: call.arguments ?? {} });
    }
    for (const result of message.toolResults ?? []) {
      const call = callsById.get(result.toolCallId);
      if (!call) continue;
      if (result.success) {
        if (resolver.getDefinition(call.name)?.permissionLevel === 'execute'
          && executeSuccessClearsFailure(call.name, call.arguments.command)) failed = undefined;
      } else if (isBashToolName(call.name) && result.metadata?.code === 'COMMAND_FAILED' && typeof call.arguments.command === 'string') {
        failed = { command: call.arguments.command, result };
      }
    }
  }
  if (!failed) return undefined;
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
  const show = (text: string) => shortenDisplayPaths(text, workspaceRoot);
  const output = typeof failed.result.metadata?.output === 'string' ? failed.result.metadata.output : '';
  const reasonLine = output.split('\n').map((line) => line.trim()).find(Boolean);
  return formatSessionTaskCommandFailed(
    locale,
    clip(show(failed.command.replace(/\s+/g, ' ').trim()), FAILED_COMMAND_MAX_CHARS),
    reasonLine ? clip(show(reasonLine), FAILED_REASON_MAX_CHARS) : undefined,
  );
}
