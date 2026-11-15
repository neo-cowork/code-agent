import type { StreamInterruptionReason, ToolCall, ToolStepStatus } from '@shared/contract';
import type { Task } from '@shared/contract/backgroundTask';
import type { TraceNode } from '@shared/contract/trace';
import type { AgentRow } from './agentRows';
import { isToolInterruptionPlaceholder } from './toolExecutionPresentation';
import { isDelegationTool, isTaskTerminalStatus } from './agentActivity';

type TerminalState = 'running' | 'completed' | 'failed' | 'interrupted' | 'hidden';

/** The call's own outcome sources, which always outrank any agent row. */
function ownOutcome(toolCall: ToolCall | undefined, sessionId: string | null | undefined, tasks?: readonly Task[]) {
  const result = isToolInterruptionPlaceholder(toolCall?.result?.error) ? undefined : toolCall?.result;
  const task = toolCall && sessionId ? tasks?.find(candidate =>
    candidate.sessionId === sessionId && candidate.toolCallId === toolCall.id) : undefined;
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
  interruptionReason?: StreamInterruptionReason;
  /** State of the work a delegation call handed off, once that work has its own task/agent record. */
  delegatedWork?: 'working' | 'completed' | 'failed' | 'cancelled';
}) {
  const { toolCall, sessionId, sessionLive, awaitingApproval, interruptionReason, delegatedWork } = input;
  const { result, task } = ownOutcome(toolCall, sessionId, input.tasks);
  const agentId = input.agentId
    ?? (typeof result?.metadata?.agentId === 'string' ? result.metadata.agentId : undefined)
    ?? result?.output?.match(/^- Agent ID:\s*(\S+)\s*$/m)?.[1];
  const row = input.agentRows?.find(candidate =>
    (agentId && candidate.key === agentId)
    || (toolCall && candidate.task?.toolCallId === toolCall.id && candidate.task.sessionId === sessionId));
  let state: TerminalState;
  // A delegation's result only acknowledges the dispatch, so the delegated work's own record outranks it
  // (a failure already recovered by a later success stays settled).
  if (delegatedWork && result?.metadata?.recovered !== true) state = delegatedWork === 'working' ? 'running' : delegatedWork === 'cancelled' ? 'interrupted' : delegatedWork;
  // Otherwise an actual call outcome takes precedence over every inferred task/agent outcome.
  else if (result) state = result.success || result.metadata?.recovered === true ? 'completed' : 'failed';
  else if (awaitingApproval) state = 'running';
  else if (task) state = task.status === 'completed' ? 'completed'
    : task.status === 'cancelled' ? 'interrupted'
      : isTaskTerminalStatus(task.status) ? 'failed' : 'running';
  else if (row && row.status !== 'standby') state = row.status === 'done' ? 'completed'
    : row.status === 'failed' ? 'failed' : row.status === 'cancelled' ? 'interrupted' : 'running';
  else if (interruptionReason) state = 'interrupted';
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
  return { state, displayStatus, stepStatus };
}

/** Preserve even empty tool results when adapting the trace's flattened representation. */
export function traceTerminalToolCall(tc: NonNullable<TraceNode['toolCall']>): ToolCall {
  return {
    id: tc.id, name: tc.name, arguments: tc.args, _streaming: tc._streaming,
    shortDescription: tc.shortDescription, stepLabel: tc.stepLabel,
    targetContext: tc.targetContext, expectedOutcome: tc.expectedOutcome, liveOutput: tc.liveOutput,
    result: tc.result !== undefined || tc.success !== undefined ? {
      toolCallId: tc.id, success: tc.success ?? true,
      output: tc.success !== false ? tc.result : undefined,
      error: tc.success === false ? tc.result : undefined,
      duration: tc.duration, outputPath: tc.outputPath,
      metadata: tc.recovered ? { ...tc.metadata, recovered: true } : tc.metadata,
    } : undefined,
  };
}
