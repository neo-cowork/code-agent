// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render as renderClient } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { AgentTreeNode } from '../../../src/shared/contract/agentTree';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import { languages, type Language } from '../../../src/renderer/i18n';
import { useAppStore } from '../../../src/renderer/stores/appStore';
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
      failure: { message: 'Interrupted', reason: 'session_command_task_interrupted_by_restart' },
      createdAt: 2, updatedAt: 3, events: [], outputRefs: [],
    };
    const withReceipt = projectBackgroundReceipts(
      projectTurns([...before, interrupted], 'session', false), [failedTask], [], languages.en,
    );
    expect(withReceipt.turns.flatMap((turn) => turn.nodes.map((node) => node.id))).not.toContain('interrupt');
  });
});

describe('background handoff ended note', () => {
  const marker: Message = {
    id: 'restart', role: 'system', content: 'Interrupted', timestamp: 3,
    metadata: { backgroundTaskInterrupted: { taskId: 't1' } },
  };
  const task = (status: Task['status'], id = 't1', interrupted = false): Task => ({
    id, status, source: 'session_command_center', title: 'Weekly report',
    ...(interrupted ? { failure: { message: 'Interrupted', reason: 'session_command_task_interrupted_by_restart' } } : {}),
    createdAt: 2, updatedAt: 3, events: [], outputRefs: [],
  });
  const delegate = (taskId: string): NonNullable<Message['toolCalls']>[number] => ({
    id: `call-${taskId}`, name: 'delegate_task', arguments: {},
    result: {
      toolCallId: `call-${taskId}`, success: true, metadata: { sessionTask: { tasks: [{ taskId }] } },
    },
  });
  const promise = 'I handed this to a background task and will tell you the result when it finishes.';
  const reply: Message = {
    id: 'reply', role: 'assistant', timestamp: 2, content: promise, toolCalls: [delegate('t1')],
  };
  const testId = 'data-testid="background-handoff-ended-note"';

  function render(entries: Message[], tasks: Task[], language: Language = 'en') {
    const previousLanguage = useAppStore.getState().language;
    useAppStore.setState({ language });
    try {
      const projection = projectBackgroundReceipts(projectTurns(entries, 'session', false), tasks, [], languages[language]);
      const nodes = projection.turns.flatMap((turn) => turn.nodes).filter((node) => node.type === 'assistant_text');
      const view = renderClient(<>{nodes.map((node) => <TraceNodeRenderer key={node.id} node={node} />)}</>);
      const html = view.container.innerHTML;
      view.unmount();
      return html;
    } finally {
      useAppStore.setState({ language: previousLanguage });
    }
  }

  it.each([
    ['zh', '后台任务已中断，结果不会再送达。', '后台任务没有完成，结果不会再送达。'],
    ['en', 'The background task was interrupted, so no result will follow.',
      'The background task failed, so no result will follow.'],
  ] as const)('appends the %s interrupted and failed copy below the unedited reply', (language, interrupted, failed) => {
    const running = [messages[0], reply];
    for (const [html, copy] of [
      [render([...running, marker], [], language), interrupted],
      [render(running, [task('failed', 't1', true)], language), interrupted],
      [render(running, [task('failed')], language), failed],
    ]) {
      expect(html.split(testId)).toHaveLength(2);
      expect(html).toContain(copy);
      expect(html.indexOf(promise)).toBeGreaterThanOrEqual(0);
      expect(html.indexOf(promise)).toBeLessThan(html.indexOf(testId));
    }
  });

  it.each(['completed', 'running', 'cancelled'] as const)('leaves a %s task without a note', (status) => {
    const text = 'I am sending this to the background.';
    const withPreview = { ...reply, content: text + '\n' + promise, metadata: { backgroundTaskPreannounce: { text } } };
    const html = render([messages[0], withPreview], [task(status)]);
    expect(html).toContain(promise);
    expect(html).not.toContain(testId);
  });

  it('renders once under the last text segment and prefers interruption over failure', () => {
    const combined: Message = {
      ...reply,
      toolCalls: [delegate('t1'), delegate('t2')],
      contentParts: [
        { type: 'text', text: 'I have split the work into two tasks.' },
        { type: 'tool_call', toolCallId: 'call-t1' },
        { type: 'text', text: promise },
        { type: 'tool_call', toolCallId: 'call-t2' },
      ],
    };
    const html = render([messages[0], combined, marker], [task('failed', 't2')]);
    expect(html.split(testId)).toHaveLength(2);
    expect(html).toContain('The background task was interrupted, so no result will follow.');
    expect(html.indexOf(promise)).toBeGreaterThanOrEqual(0);
    expect(html.indexOf(promise)).toBeLessThan(html.indexOf(testId));
  });

  it('replays the interruption from persisted messages without saving derived metadata', () => {
    const entries = [messages[0], reply, marker];
    const html = render(entries, []);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('backgroundHandoffEnded');
    expect(html).toContain(testId);
    expect(render(JSON.parse(serialized), [])).toEqual(html);
  });

  it('does not attach the note to another reply when the calling message has no text', () => {
    const toolOnly = { ...reply, content: '', reasoning: 'Planning' };
    const otherReply: Message = { ...reply, id: 'other', toolCalls: [] };
    expect(render([messages[0], toolOnly, otherReply, marker], [])).not.toContain(testId);
  });

  it('puts the note under the acknowledgement when the dispatch only had a system preview', () => {
    const text = 'I am sending this to the background.';
    const dispatch = {
      ...reply, content: text, metadata: {
        backgroundTaskPreannounce: { text, toolCallId: 'call-t1' },
        correlation: { traceId: 'foreground-run', turnId: 'dispatch-turn' },
      },
    };
    const acknowledgement = {
      ...reply, id: 'acknowledgement', toolCalls: [],
      metadata: { correlation: { traceId: 'foreground-run', turnId: 'reply-turn' } },
    };
    const html = render([messages[0], dispatch, acknowledgement, marker], []);
    expect(html.split(testId)).toHaveLength(2);
    expect(html).not.toContain(text);
    expect(html.indexOf(promise)).toBeGreaterThanOrEqual(0);
    expect(html.indexOf(promise)).toBeLessThan(html.indexOf(testId));
    const unrelated = { ...acknowledgement, metadata: { correlation: { traceId: 'other-run', turnId: 'other-turn' } } };
    expect(render([messages[0], dispatch, unrelated, marker], [])).not.toContain(testId);
  });
});
