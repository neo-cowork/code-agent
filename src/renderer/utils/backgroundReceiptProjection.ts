import type { AgentTreeNode } from '@shared/contract/agentTree';
import type { Task } from '@shared/contract/backgroundTask';
import type { MessageMetadata } from '@shared/contract/message';
import type { TraceNode, TraceProjection } from '@shared/contract/trace';
import {
  delegatedBackgroundTaskId,
  deriveDelegationPresentation,
} from '../components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';
import type { Translations } from '../i18n';
import { isTaskTerminalStatus } from './agentActivity';
import { traceTerminalToolCall } from './toolCallTerminalState';

type HandoffEnd = NonNullable<MessageMetadata['backgroundHandoffEnded']>;

export function projectBackgroundReceipts(
  projection: TraceProjection,
  tasks: Task[],
  agents: AgentTreeNode[],
  t: Translations,
): TraceProjection {
  const nodes = projection.turns.flatMap((turn) => turn.nodes);
  if (!tasks.some(({ status }) => isTaskTerminalStatus(status) && status !== 'completed' && status !== 'cancelled')
    && !nodes.some(({ metadata }) => metadata?.backgroundTaskStopped || metadata?.backgroundTaskInterrupted || metadata?.backgroundTaskPreannounce)) {
    return projection;
  }

  const terminalReceiptIds = new Set<string>();
  const stoppedTaskIds = new Set<string>();
  const interruptionReceiptIds = new Set<string>();
  const interruptedTaskIds = new Set<string>();
  const failedCallIds = new Set<string>();
  const delegateCallsByMessage = new Map<string, string[]>();
  const handoffEndedByMessage = new Map<string, HandoffEnd>();
  const lastTextByMessage = new Map<string, TraceNode>();
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  for (const node of nodes) {
    const { metadata } = node;
    const taskId = metadata?.backgroundTaskStopped?.taskId ?? metadata?.backgroundTaskInterrupted?.taskId;
    if (taskId) stoppedTaskIds.add(taskId);
    if (metadata?.backgroundTaskInterrupted) interruptedTaskIds.add(metadata.backgroundTaskInterrupted.taskId);
    if (node.type === 'assistant_text' && node.messageId && node.content.trim()) lastTextByMessage.set(node.messageId, node);
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
    if (!node.messageId || receipt?.state === 'cancelled' || receipt?.state === 'completed') continue;
    if (receipt?.failure === t.backgroundPanel.interrupted || (taskId && interruptedTaskIds.has(taskId))) {
      handoffEndedByMessage.set(node.messageId, 'interrupted');
    } else if (receipt?.state === 'failed' && !handoffEndedByMessage.has(node.messageId)) {
      handoffEndedByMessage.set(node.messageId, 'failed');
    }
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
    let pending: { messageId: string; traceId: string; end: HandoffEnd } | undefined;
    const visibleNodes = turn.nodes.flatMap((original) => presentNode(original).map((node) => {
      const messageId = node.messageId;
      if (node.toolCall && pending?.messageId !== messageId) pending = undefined;
      if (!messageId || node.type !== 'assistant_text') return node;

      const end = lastTextByMessage.get(messageId) === original ? handoffEndedByMessage.get(messageId) : undefined;
      const traceId = node.metadata?.correlation?.traceId;
      if (!node.content.trim()) {
        // The preview can be the dispatch message's only text. In that case the
        // confirmed handoff is the next model reply in the same foreground run.
        if (end && traceId && original.metadata?.backgroundTaskPreannounce) pending = { messageId, traceId, end };
        return node;
      }
      const backgroundHandoffEnded = end ?? (pending?.traceId === traceId ? pending?.end : undefined);
      pending = undefined;
      return backgroundHandoffEnded ? { ...node, metadata: { ...node.metadata, backgroundHandoffEnded } } : node;
    }));
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
