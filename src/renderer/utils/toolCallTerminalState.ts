import type { StreamInterruptionReason, ToolCall, ToolStepStatus } from '@shared/contract';
import type { Task } from '@shared/contract/backgroundTask';
import type { TraceNode } from '@shared/contract/trace';
import type { AgentRow } from './agentRows';
import { isToolInterruptionPlaceholder } from './toolExecutionPresentation';
import { isParkedApprovalClosureSentence } from '@shared/parkedApprovalClosure';
import { classifyToolName } from './humanizeToolStep';
import { isDelegationTool, isTaskTerminalStatus } from './agentActivity';

type TerminalState = 'running' | 'completed' | 'failed' | 'interrupted' | 'hidden';

/** What a handed-off call may claim: the task's real outcome, or nothing when no task row is known. */
type HandedOffOutcome = 'completed' | 'failed' | 'running' | 'neutral';

/** The call's own outcome sources, which always outrank any agent row. */
function ownOutcome(toolCall: ToolCall | undefined, sessionId: string | null | undefined, tasks?: readonly Task[]) {
  const result = isToolInterruptionPlaceholder(toolCall?.result?.error) ? undefined : toolCall?.result;
  // A call the host handed to a background task is settled by that task's row, which is keyed by the
  // handoff's own id (stamped on the sealed result), not by this call's id.
  const handoffTaskId = result?.metadata?.code === 'HANDED_OFF_TO_BACKGROUND'
    && typeof result.metadata.handoffTaskToolCallId === 'string' ? result.metadata.handoffTaskToolCallId : undefined;
  const task = toolCall && sessionId ? tasks?.find(candidate =>
    candidate.sessionId === sessionId && (candidate.toolCallId === toolCall.id
      || (handoffTaskId !== undefined && candidate.toolCallId === handoffTaskId))) : undefined;
  return { result, task };
}

/** An agent row can only settle a result-less call that has no ledger task and names its owning agent. */
export function toolCallNeedsAgentRows(input: {
  toolCall?: ToolCall; sessionId?: string | null; tasks?: readonly Task[]; agentId?: string;
}): boolean {
  const { result, task } = ownOutcome(input.toolCall, input.sessionId, input.tasks);
  return Boolean(input.agentId && !result && !task);
}

/** Presentation only: exact call/agent ownership, never a turn-wide successful-task heuristic. */
export function resolveToolCallTerminalState(input: {
  toolCall?: ToolCall;
  sessionId?: string | null;
  tasks?: readonly Task[];
  agentRows?: readonly AgentRow[];
  agentId?: string;
  sessionLive?: boolean;
  awaitingApproval?: boolean;
  /** The user (or timeout) already answered this call's approval but its result has not arrived. */
  approvalAnswered?: boolean;
  interruptionReason?: StreamInterruptionReason;
  /** State of the work a delegation call handed off, once that work has its own task/agent record. */
  delegatedWork?: 'working' | 'completed' | 'failed' | 'cancelled';
}) {
  const { toolCall, sessionId, sessionLive, awaitingApproval, approvalAnswered, interruptionReason, delegatedWork } = input;
  const { result, task } = ownOutcome(toolCall, sessionId, input.tasks);
  // 同一轮已交给后台任务的调用：工作没丢，不当失败、也不读作「没执行」。
  const handedOff = result?.metadata?.code === 'HANDED_OFF_TO_BACKGROUND';
  const agentId = input.agentId
    ?? (typeof result?.metadata?.agentId === 'string' ? result.metadata.agentId : undefined)
    ?? result?.output?.match(/^- Agent ID:\s*(\S+)\s*$/m)?.[1];
  const row = input.agentRows?.find(candidate =>
    (agentId && candidate.key === agentId)
    || (toolCall && candidate.task?.toolCallId === toolCall.id && candidate.task.sessionId === sessionId));
  let state: TerminalState;
  let handedOffOutcome: HandedOffOutcome | undefined;
  // A delegation's result only acknowledges the dispatch, so the delegated work's own record outranks it
  // (a failure already recovered by a later success stays settled).
  if (delegatedWork && result?.metadata?.recovered !== true) state = delegatedWork === 'working' ? 'running' : delegatedWork === 'cancelled' ? 'interrupted' : delegatedWork;
  // Otherwise an actual call outcome takes precedence over every inferred task/agent outcome.
  else if (result && handedOff) {
    // Not a failure a later success fixed: the step's state is whatever the task it was handed to ended as.
    handedOffOutcome = !task ? 'neutral' : !isTaskTerminalStatus(task.status) ? 'running'
      : task.status === 'completed' ? 'completed' : 'failed';
    state = handedOffOutcome === 'failed' ? 'failed' : handedOffOutcome === 'running' ? 'running' : 'completed';
  }
  else if (result) state = result.success || result.metadata?.recovered === true ? 'completed' : 'failed';
  else if (awaitingApproval) state = 'running';
  else if (task) state = task.status === 'completed' ? 'completed'
    : task.status === 'cancelled' ? 'interrupted'
      : isTaskTerminalStatus(task.status) ? 'failed' : 'running';
  else if (row && row.status !== 'standby') state = row.status === 'done' ? 'completed'
    : row.status === 'failed' ? 'failed' : row.status === 'cancelled' ? 'interrupted' : 'running';
  else if (interruptionReason) state = 'interrupted';
  else if (approvalAnswered) state = 'running';
  else if (sessionLive) state = 'running';
  else state = toolCall?._streaming ? 'hidden' : 'interrupted';
  // A terminal shell task has its own receipt; drop only its result-less background placeholder.
  if (!result && state === 'completed' && toolCall && !isDelegationTool(toolCall.name)
    && task && (task.kind === 'shell' || task.source === 'shell')
    && toolCall.arguments?.run_in_background === true) state = 'hidden';
  const displayStatus = state === 'running' ? 'pending' as const
    : state === 'failed' ? 'error' as const : state === 'interrupted' ? 'interrupted' as const : 'success' as const;
  const stepStatus: ToolStepStatus = awaitingApproval && !result ? 'pending-approval'
    : state === 'running' ? 'running' : state === 'failed' ? 'failed' : 'completed';
  // 停车审批被自动收口：命令从未执行，标题不能说「未成功」。
  const notRun = result?.success === false && result.metadata?.recovered !== true
    && isParkedApprovalClosureSentence(result.error);
  // 主机封存、从未执行的 Bash（metadata.skipped）：即使被降级为 recovered（state 仍是 completed、
  // 不变色），标题也不能说「运行了」。executed===true 是命令跑完后才被读循环封口替换的结果，不算没执行。只改措辞，不改 state。
  const skipped = result?.metadata?.skipped === true && result.metadata.executed !== true && !handedOff && !!toolCall && classifyToolName(toolCall.name) === 'bash';
  return { state, displayStatus, stepStatus, notRun, skipped, handedOff, handedOffOutcome, handoffTask: handedOff ? task : undefined };
}

/** Preserve even empty tool results when adapting the trace's flattened representation. */
export function traceTerminalToolCall(tc: NonNullable<TraceNode['toolCall']>): ToolCall {
  return {
    id: tc.id, name: tc.name, arguments: tc.args, _streaming: tc._streaming,
    shortDescription: tc.shortDescription, stepLabel: tc.stepLabel,
    targetContext: tc.targetContext, expectedOutcome: tc.expectedOutcome, liveOutput: tc.liveOutput,
    guiTakeoverDisclosure: tc.guiTakeoverDisclosure,
    result: tc.result !== undefined || tc.success !== undefined ? {
      toolCallId: tc.id, success: tc.success ?? true,
      output: tc.success !== false ? tc.result : undefined,
      error: tc.success === false ? tc.result : undefined,
      ...(tc.userMessage !== undefined ? { userMessage: tc.userMessage } : {}),
      duration: tc.duration, outputPath: tc.outputPath,
      metadata: tc.recovered ? { ...tc.metadata, recovered: true } : tc.metadata,
    } : undefined,
  };
}
