import { describe, expect, it } from 'vitest';
import type { AgentErrorCategory, Message, ToolCall } from '../../../src/shared/contract';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { projectAgentErrorRuns } from '../../../src/renderer/utils/agentErrorRuns';
import { projectSupersededDelegationFailures } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationFailureRuns';
import { deriveDelegationPresentation } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';

const causes = {
  A: { category: 'auth', message: 'HTTP 401: invalid API key' },
  B: { category: 'network', message: 'ECONNRESET: connection reset' },
  generic: { category: 'generic', message: 'unrecognised failure detail' },
} satisfies Record<string, { category: AgentErrorCategory; message: string }>;
type Event = keyof typeof causes | 'success' | 'ack-A';

// One table drives both real public projections, including their distinct timing adapters.
const scenarios: { name: string; events: Event[]; folded: number[]; lengths: number[] }[] = [
  { name: 'A,A,A folds older two and keeps newest', events: ['A', 'A', 'A'], folded: [0, 1], lengths: [1, 2, 3] },
  { name: 'A,B keeps both causes', events: ['A', 'B'], folded: [], lengths: [1, 1] },
  { name: 'failure, successful reply, failure resets', events: ['A', 'success', 'A'], folded: [], lengths: [1, 1] },
  { name: 'acknowledgement before failure ended does not reset', events: ['ack-A', 'A'], folded: [0], lengths: [1, 2] },
  { name: 'single failure unchanged', events: ['A'], folded: [], lengths: [1] },
];

function history(events: Event[], surface: 'agent' | 'delegation') {
  const messages: Message[] = [];
  const tasks: Task[] = [];
  const ids: string[] = [];
  events.forEach((event, index) => {
    const at = (index + 1) * 1000;
    messages.push({ id: `user-${index}`, role: 'user', content: 'request', timestamp: at - 10 });
    if (event === 'success') {
      messages.push({ id: `reply-${index}`, role: 'assistant', content: 'successful reply', timestamp: at });
      return;
    }
    const cause = causes[event === 'ack-A' ? 'A' : event];
    const ack: Message = { id: `ack-${index}`, role: 'assistant', content: 'working on it', timestamp: at + 100 };
    const id = `failure-${index}`;
    ids.push(id);
    if (surface === 'agent') {
      // Agent errors are projected at round granularity: acknowledgement and failure share a round.
      if (event === 'ack-A') messages.push(ack);
      messages.push({ id, role: 'assistant', content: '', timestamp: at + 500,
        metadata: { agentError: { category: cause.category, rawMessage: cause.message, timestamp: at + 500 } } });
    } else {
      const call: ToolCall = { id, name: 'delegate_task', arguments: { title: 'request' },
        result: { toolCallId: id, success: true, output: 'accepted',
          metadata: { sessionTask: { outcome: 'accepted', tasks: [{ taskId: `task-${index}` }] } } } };
      messages.push({ id: `dispatch-${index}`, role: 'assistant', content: '', timestamp: at, toolCalls: [call] });
      // Delegation receipts exist before their asynchronous failure finishes.
      if (event === 'ack-A') messages.push(ack);
      tasks.push({ id: `task-${index}`, sessionId: 'session-1', toolCallId: id, source: 'delegate',
        title: 'request', status: 'failed', createdAt: at, updatedAt: at + 500, completedAt: at + 500,
        events: [], outputRefs: [], failure: { reason: 'task_failed', message: cause.message } });
    }
  });
  return { messages, tasks, ids };
}

function agent(events: Event[]) {
  const { messages, ids } = history(events, 'agent');
  // Use actual TraceTurns from the production turn builder, as in agentErrorRun tests.
  const turns = projectTurns(messages, 'session-1', false).turns;
  for (const turn of turns) for (const node of turn.nodes) delete node.agentErrorRun;
  projectAgentErrorRuns(messages, turns);
  const nodes = turns.flatMap(turn => turn.nodes).filter(node => node.metadata?.agentError);
  return {
    folded: nodes.filter(node => node.agentErrorRun?.latest === false).map(node => ids.indexOf(node.messageId ?? node.id)),
    lengths: nodes.map(node => node.agentErrorRun?.runLength),
  };
}

function delegation(events: Event[]) {
  const { messages, tasks, ids } = history(events, 'delegation');
  const superseded = projectSupersededDelegationFailures(messages, call => deriveDelegationPresentation(call, tasks, []));
  return [...superseded].map(id => ids.indexOf(id));
}

describe.each(scenarios)('shared failure rule: $name', ({ events, folded, lengths }) => {
  it('agent surface', () => {
    expect(agent(events)).toEqual({ folded, lengths });
  });
  it('delegation surface', () => {
    expect(delegation(events)).toEqual(folded);
  });
  it('both surfaces agree', () => {
    expect(agent(events).folded).toEqual(delegation(events));
  });
});

it('generic intentionally chains only on the agent surface', () => {
  // PR #3503 FOLD rework r1: generic/unknown delegation failures are not a shared cause.
  const events: Event[] = ['generic', 'generic'];
  expect(agent(events)).toEqual({ folded: [0], lengths: [1, 2] });
  expect(delegation(events)).toEqual([]);
  // Unknown cause also breaks an otherwise matching delegation run.
  expect(delegation(['A', 'generic', 'A'])).toEqual([]);
});
