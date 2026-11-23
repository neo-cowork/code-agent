import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { AgentTreeNode } from '../../../src/shared/contract/agentTree';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import { languages } from '../../../src/renderer/i18n';
import { projectBackgroundReceipts } from '../../../src/renderer/utils/backgroundReceiptProjection';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';

const NOTE = '「百科摘要」：后台任务做到第 3 步（上限 3 步）就用完了步数，还没有得出最终结果。';
const messages: Message[] = [
  { id: 'u', role: 'user', content: '在后台查百度百科', timestamp: 1 },
  { id: 'a', role: 'assistant', content: '好的，我已经安排好了', timestamp: 2 },
  {
    id: 'stop', role: 'system', content: NOTE, timestamp: 3,
    metadata: { backgroundTaskStopped: { taskId: 't1', kind: 'step_cap' } },
  },
];

describe('backgroundTaskStopped after a finished foreground turn', () => {
  it('is its own trailing turn and renders as a plain conclusion row, not italic process noise', () => {
    const turns = projectTurns(messages, 'session', false).turns;
    const last = turns[turns.length - 1];
    expect(last.nodes.map((n) => n.id)).toEqual(['stop']);
    expect(turns.slice(0, -1).flatMap((t) => t.nodes).some((n) => n.id === 'stop')).toBe(false);
    const html = renderToStaticMarkup(<TraceNodeRenderer node={last.nodes[0]} />);
    expect(html).toContain(NOTE);
    expect(html).toContain('data-testid="background-task-stopped-note"');
    expect(html).not.toContain('italic');
  });

  it('keeps a stop note until the transcript has a terminal delegation receipt for that helper', () => {
    const agent: AgentTreeNode = {
      id: 'agent-1', backgroundAgentId: 't1', role: 'explore', background: true, status: 'failed', statusLabel: '',
      failureCode: AgentFailureCode.StepCapReached, children: [], worktreeState: { status: 'none' },
      budgetSummary: {}, evidenceRefs: [], sources: ['subagentContext'],
    };
    const dispatch: Message = {
      id: 'dispatch', role: 'assistant', content: '', timestamp: 2,
      toolCalls: [{
        id: 'spawn', name: 'spawn_agent', arguments: {},
        result: { toolCallId: 'spawn', success: true, metadata: { agentId: agent.id } },
      }],
    };
    const projection = projectTurns([messages[0], dispatch, messages[2]], 'session', false);
    const ids = (nodes: typeof projection) => nodes.turns.flatMap((turn) => turn.nodes.map((node) => node.id));
    expect(ids(projectBackgroundReceipts(projection, [], [{ ...agent, status: 'running' }], languages.zh))).toContain('stop');
    const visible = ids(projectBackgroundReceipts(projection, [], [agent], languages.zh));
    expect(visible).toContain('dispatch-tc-spawn');
    expect(visible).not.toContain('stop');
  });

  it.each([true, false])('retracts the promise only for the interrupted task (explicit link %s)', (linked) => {
    const text = 'I’ll hand this to a background assistant.';
    const dispatch = (id: string, taskId: string): Message => ({
      id, role: 'assistant', timestamp: 2, content: text + '\nI can keep helping here.',
      metadata: { backgroundTaskPreannounce: { text, ...(linked && { toolCallId: id + '-call' }) } },
      toolCalls: [{
        id: id + '-call', name: 'delegate_task', arguments: {},
        result: { toolCallId: id + '-call', success: true, metadata: { sessionTask: { tasks: [{ taskId }] } } },
      }],
    });
    const before = [messages[0], dispatch('first', 't1'), dispatch('second', 't2')];
    const interrupted: Message = {
      id: 'interrupt', role: 'system', content: 'Interrupted', timestamp: 3,
      metadata: { backgroundTaskInterrupted: { taskId: 't1' } },
    };
    const renderProjection = (entries: Message[]) => {
      const projection = projectBackgroundReceipts(projectTurns(entries, 'session', false), [], [], languages.en);
      return renderToStaticMarkup(<>{projection.turns.flatMap((turn) =>
        turn.nodes.filter((node) => node.type === 'assistant_text' || node.type === 'system')
          .map((node) => <TraceNodeRenderer key={node.id} node={node} />))}</>);
    };
    expect(renderProjection(before).match(/交给后台执行/g)).toHaveLength(2);
    const after = renderProjection([...before, interrupted]);
    expect(after.match(/交给后台执行/g)).toHaveLength(1);
    expect(after).toContain('I can keep helping here.');
    expect(after).toContain(languages.zh.backgroundPanel.interrupted);

    const failedTask: Task = {
      id: 't1', source: 'session_command_center', title: 'Summarize notes', status: 'failed',
      failure: { reason: 'session_command_task_interrupted_by_restart' },
      createdAt: 2, updatedAt: 3, events: [], outputRefs: [],
    };
    const withReceipt = projectBackgroundReceipts(
      projectTurns([...before, interrupted], 'session', false), [failedTask], [], languages.en,
    );
    expect(withReceipt.turns.flatMap((turn) => turn.nodes.map((node) => node.id))).not.toContain('interrupt');
  });
});
