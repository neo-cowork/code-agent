import type { AgentTreeNode } from '@shared/contract/agentTree';
import type { Task } from '@shared/contract/backgroundTask';
import type { TraceNode, TraceProjection } from '@shared/contract/trace';
import {
  delegatedBackgroundTaskId,
  deriveDelegationPresentation,
} from '../components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';
import type { Translations } from '../i18n';
import { traceTerminalToolCall } from './toolCallTerminalState';

export function projectBackgroundReceipts(
  projection: TraceProjection,
  tasks: Task[],
  agents: AgentTreeNode[],
  t: Translations,
): TraceProjection {
  const nodes = projection.turns.flatMap((turn) => turn.nodes);
  if (!nodes.some(({ metadata }) => metadata?.backgroundTaskStopped || metadata?.backgroundTaskInterrupted || metadata?.backgroundTaskPreannounce)) {
    return projection;
  }

  const terminalReceiptIds = new Set<string>();
  const stoppedTaskIds = new Set<string>();
  const interruptionReceiptIds = new Set<string>();
  const failedCallIds = new Set<string>();
  const delegateCallsByMessage = new Map<string, string[]>();
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  for (const { metadata } of nodes) {
    const taskId = metadata?.backgroundTaskStopped?.taskId ?? metadata?.backgroundTaskInterrupted?.taskId;
    if (taskId) stoppedTaskIds.add(taskId);
  }

  for (const node of nodes) {
    const traceCall = node.toolCall;
    if (!traceCall || (traceCall.name !== 'spawn_agent' && traceCall.name !== 'delegate_task')) continue;
    const call = traceTerminalToolCall(traceCall);
    const receipt = deriveDelegationPresentation(call, tasks, agents, t);
    const stopped = receipt?.state === 'failed' || receipt?.state === 'cancelled';
    if (stopped && receipt.memberId) {
      terminalReceiptIds.add(receipt.memberId);
      const alias = agentsById.get(receipt.memberId)?.backgroundAgentId;
      if (call.name === 'spawn_agent' && alias) terminalReceiptIds.add(alias);
    }
    if (call.name !== 'delegate_task') continue;
    if (receipt?.memberId && receipt.failure === t.backgroundPanel.interrupted) interruptionReceiptIds.add(receipt.memberId);
    if (node.messageId) {
      const calls = delegateCallsByMessage.get(node.messageId) ?? [];
      calls.push(call.id);
      delegateCallsByMessage.set(node.messageId, calls);
    }
    const taskId = receipt?.memberId ?? delegatedBackgroundTaskId(call);
    if (stopped || (taskId && stoppedTaskIds.has(taskId))) failedCallIds.add(call.id);
  }

  function presentNode(node: TraceNode): TraceNode[] {
    const stopNote = node.metadata?.backgroundTaskStopped;
    const interrupted = node.metadata?.backgroundTaskInterrupted;
    if ((stopNote && terminalReceiptIds.has(stopNote.taskId))
      || (interrupted && interruptionReceiptIds.has(interrupted.taskId))) return [];
    const preannounce = node.type === 'assistant_text' ? node.metadata?.backgroundTaskPreannounce : undefined;
    if (!preannounce?.text || !node.content.startsWith(preannounce.text)) return [node];
    const calls = node.messageId ? delegateCallsByMessage.get(node.messageId) : undefined;
    const callId = preannounce.toolCallId ?? (calls?.length === 1 ? calls[0] : undefined);
    if (!callId || !failedCallIds.has(callId)) return [node];
    return [{
      ...node,
      content: node.content.slice(preannounce.text.length).trimStart(),
      metadata: { ...node.metadata, backgroundTaskPreannounce: undefined },
    }];
  }

  const activeTurn = projection.turns[projection.activeTurnIndex];
  const turns = projection.turns.flatMap((turn) => {
    const visibleNodes = turn.nodes.flatMap(presentNode);
    if (turn.nodes.length && !visibleNodes.length) return [];
    return visibleNodes.length === turn.nodes.length && visibleNodes.every((node, index) => node === turn.nodes[index])
      ? [turn] : [{ ...turn, nodes: visibleNodes }];
  });
  return {
    ...projection,
    turns,
    activeTurnIndex: activeTurn ? turns.findIndex((turn) => turn.turnId === activeTurn.turnId) : -1,
  };
}
