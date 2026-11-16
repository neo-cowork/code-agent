import type { Message } from '@shared/contract';
import type { TraceNode, TraceTurn } from '@shared/contract/trace';
import { isToolInterruptionPlaceholder } from './toolExecutionPresentation';

function parkedSteps(nodes: readonly TraceNode[]) {
  return nodes.flatMap((node, index) => {
    const callId = node.metadata?.envAssist?.parkedToolCallId;
    if (!callId) return [];
    const call = nodes.slice(0, index).find(candidate => candidate.toolCall?.id === callId)?.toolCall;
    return call ? [{ call, index, node }] : [];
  });
}

/** Only the exact parked call yields to a successful continuation of its action in this turn. */
export function supersededEnvParkedCalls(nodes: readonly TraceNode[]): Set<string> {
  const superseded = new Set<string>();
  for (const { call, index } of parkedSteps(nodes)) {
    if ((call.result !== undefined || call.success !== undefined) && !isToolInterruptionPlaceholder(call.result)) continue;
    const continued = nodes.slice(index + 1).some(node => {
      const next = node.toolCall;
      return next?.id !== call.id && next?.name === call.name && next.success === true
        && next.args.action === call.args.action && next.args.calendar === call.args.calendar;
    });
    if (continued) superseded.add(call.id);
  }
  return superseded;
}

/** Message timestamps include recovery tool receipts, which have no standalone trace node. */
export function envParkedTurnDuration(turn: TraceTurn, messages: readonly Message[]): number | null {
  if (turn.endTime === undefined) return null;
  const endTime = turn.endTime;
  const spans = parkedSteps(turn.nodes).map(({ call, node, index }) => {
    const start = Math.max(turn.startTime, node.timestamp);
    const resumedMessage = messages.find(message => message.timestamp > node.timestamp
      && message.timestamp <= endTime && (message.role === 'assistant'
        || (message.role === 'tool' && message.toolResults?.some(result => result.toolCallId === call.id)))
      && !message.metadata?.envAssist);
    // A trace supplied without its raw history can still bound the wait by its first resumed node.
    const resumedNode = turn.nodes.slice(index + 1).find(candidate => candidate.timestamp > node.timestamp
      && !candidate.metadata?.envAssist && (candidate.type === 'assistant_text' || candidate.type === 'tool_call'));
    return [start, Math.min(endTime, resumedMessage?.timestamp ?? resumedNode?.timestamp ?? endTime)] as const;
  }).sort((a, b) => a[0] - b[0]);
  let wait = 0;
  let previousEnd = turn.startTime;
  for (const [start, end] of spans) {
    wait += Math.max(0, end - Math.max(start, previousEnd));
    previousEnd = Math.max(previousEnd, end);
  }
  return Math.max(0, endTime - turn.startTime - wait);
}
