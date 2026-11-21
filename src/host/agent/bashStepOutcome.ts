// 委派任务里 Bash 步骤的「未执行」落标：身份在源头（toolCallId），结果到达时按同一个 id 精确标记。
// 没有该 callId 的步骤 → 什么都不做；绝不回退到命令文本/位置匹配（命令文本相同的两次调用只有一次被拒时会标错）。
import type { BashStep, LastToolStep, TaskProgress } from '../../shared/contract/backgroundTask';
import { HostReasonCode } from '../../shared/contract/permission';
import type { Message } from '../../shared/contract/message';
import type { ToolResult } from '../../shared/contract/tool';

const MAX_BASH_STEPS = 20;
const isBashTool = (name: string): boolean => name === 'Bash' || name === 'bash';
const HANDED_OFF_CODE = 'HANDED_OFF_TO_BACKGROUND';

/** 与前台 toolCallTerminalState 同口径：主机封存且未执行，或权限层拒绝（用户/超时/取消/兜底拒）= 命令从未跑。 */
export function toolResultNeverRan(result: Pick<ToolResult, 'metadata'>): boolean {
  const meta = result.metadata;
  if (!meta) return false;
  if (meta.skipped === true && meta.executed !== true && meta.code !== HANDED_OFF_CODE) return true;
  const code = (meta.hostReason as { code?: unknown } | undefined)?.code;
  return code === HostReasonCode.PermissionDeniedByUser
    || code === HostReasonCode.PermissionDeniedTimeout
    || code === HostReasonCode.PermissionDeniedCancelled
    || code === HostReasonCode.PermissionDeniedFailClosed;
}

export function appendBashStep(steps: readonly BashStep[] | undefined, step: BashStep): BashStep[] {
  return [...(steps ?? []), step].slice(-MAX_BASH_STEPS);
}

export function markBashStepNotRun(
  steps: readonly BashStep[] | undefined,
  callId: string,
  result: Pick<ToolResult, 'metadata'>,
): BashStep[] | undefined {
  if (!steps || !toolResultNeverRan(result)) return steps as BashStep[] | undefined;
  return steps.map((step) => (step.callId === callId ? { ...step, notRun: true } : step));
}

export function markLastToolStepNotRun(
  step: LastToolStep | undefined,
  callId: string,
  result: Pick<ToolResult, 'metadata'>,
): LastToolStep | undefined {
  if (step?.callId !== callId || !isBashTool(step.tool) || !toolResultNeverRan(result)) return step;
  return { ...step, notRun: true };
}

/** task_progress 事件 → 一条 Bash 步骤（callId 来自 prepare 阶段的 toolCallId）。 */
export function bashStepFromProgress(data: { description?: string; target?: string; toolCallId?: string }): BashStep {
  return {
    ...(data.description ? { description: data.description } : {}),
    command: data.target ?? '',
    ...(data.toolCallId ? { callId: data.toolCallId } : {}),
  };
}

/** tool_call_end 到达：把同 callId 的 Bash 步骤与最近一步按 result 落标；无匹配 callId → 原样返回。 */
export function withToolCallOutcome(progress: TaskProgress | undefined, result: ToolResult): TaskProgress | undefined {
  if (!progress) return progress;
  const bashSteps = markBashStepNotRun(progress.bashSteps, result.toolCallId, result);
  const lastToolStep = markLastToolStepNotRun(progress.lastToolStep, result.toolCallId, result);
  if (bashSteps === progress.bashSteps && lastToolStep === progress.lastToolStep) return progress;
  return { ...progress, ...(bashSteps ? { bashSteps } : {}), ...(lastToolStep ? { lastToolStep } : {}) };
}

/** 子代理执行器：Bash 调用 → 步骤（命令截 200 字，callId = 调用 id）。 */
export function bashStepFromToolCall(call: { id: string; arguments?: unknown }): BashStep {
  const args = call.arguments as { description?: unknown; command?: unknown } | undefined;
  return {
    ...(typeof args?.description === 'string' && args.description ? { description: args.description } : {}),
    command: typeof args?.command === 'string' ? args.command.slice(0, 200) : '',
    callId: call.id,
  };
}

/**
 * 重建节点时的「未执行」callId 集：执行器快照里已落标的步骤（执行器是结果的第一手见证，
 * 持久化消息里只有 "Tool results:" 文本、没有结构化结果）+ 消息里若带结构化 toolResults 的那批。
 * 一律按 callId，不按命令文本。
 */
export function toolNotRunCallIds(
  messages: readonly Pick<Message, 'toolResults'>[],
  snapshotSteps?: readonly BashStep[],
): Set<string> {
  const ids = new Set<string>();
  for (const step of snapshotSteps ?? []) if (step.notRun && step.callId) ids.add(step.callId);
  for (const message of messages) {
    for (const result of message.toolResults ?? []) if (toolResultNeverRan(result)) ids.add(result.toolCallId);
  }
  return ids;
}
