// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, ToolCall } from '../../../src/shared/contract';
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const state = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  currentSessionId: 'session',
  messages: [] as Message[],
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: state.language === 'zh' ? zh : en }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (select: (store: typeof state) => unknown) => select(state),
}));

afterEach(() => {
  cleanup();
  state.currentSessionId = 'session';
  state.messages = [];
});

const shortName = 'Web standards';
const detail = 'Reading the first page';
const rawOutput = 'Web standards: running';

function makePoll(): ToolCall {
  return {
    id: 'poll',
    name: 'task_status',
    arguments: {},
    result: {
      toolCallId: 'poll',
      success: true,
      output: rawOutput,
      metadata: { sessionTask: { outcome: 'status', tasks: [{ shortName, status: 'running', detail }] } },
    },
  };
}

function pollMessage(poll: ToolCall): Message {
  return { id: 'poll-message', role: 'assistant', content: '', timestamp: 2, toolCalls: [poll] };
}

type FinalStatus = NonNullable<NonNullable<Message['metadata']>['backgroundTaskResult']>['status'];

function taskResult(status: FinalStatus, timestamp: number, name = shortName): Message {
  return {
    id: `result-${timestamp}`,
    role: 'system',
    content: 'Task result',
    timestamp,
    metadata: { backgroundTaskResult: { source: 'agent-result', taskId: `task-${timestamp}`, shortName: name, status, summary: '' } },
  };
}

describe.each([
  { locale: 'zh', running: '进行中', completed: '已完成', failed: '失败' },
  { locale: 'en', running: 'Running', completed: 'Completed', failed: 'Failed' },
] as const)('task status card ($locale)', ({ locale, running, completed, failed }) => {
  it.each([
    { status: 'completed', expected: completed },
    { status: 'failed', expected: failed },
  ] as const)('updates running to $status in the summary and details', ({ status, expected }) => {
    state.language = locale;
    const poll = makePoll();
    state.messages = [pollMessage(poll)];
    const card = <ToolCallDisplay toolCall={poll} index={0} total={1} />;
    const view = render(card);
    expect(view.container.textContent).toContain(running);

    state.messages = [...state.messages, taskResult(status, 3), taskResult('cancelled', 4)];
    view.rerender(<ToolCallDisplay toolCall={poll} index={0} total={1} />);
    const row = screen.getByTestId('tool-call-row-task_status');
    expect(row.textContent).toContain(`${shortName}\u3000${expected}`);
    expect(row.textContent).not.toContain(running);
    expect(row.textContent).not.toContain(detail);

    fireEvent.click(row);
    expect(view.container.textContent).toContain(`${shortName}\u3000${expected}`);
    expect(view.container.textContent).not.toContain(running);
    expect(view.container.textContent).not.toContain(detail);
    expect(poll).toEqual(makePoll());
  });

  it.each([
    { scenario: 'no later result', before: [], after: [] },
    { scenario: 'a different task', before: [], after: [taskResult('completed', 3, 'Other task')] },
    { scenario: 'an unverified first result', before: [], after: [taskResult('unverified', 3), taskResult('completed', 4)] },
    { scenario: 'a result before the poll', before: [taskResult('completed', 1)], after: [] },
  ])('keeps the snapshot with $scenario', ({ before, after }) => {
    state.language = locale;
    const poll = makePoll();
    state.messages = [...before, pollMessage(poll), ...after];
    render(<ToolCallDisplay toolCall={poll} index={0} total={1} />);
    const row = screen.getByTestId('tool-call-row-task_status');
    expect(row.textContent).toContain(`${shortName}\u3000${running}`);
    expect(row.textContent).toContain(detail);
  });

  it('keeps the snapshot when the card belongs to a different session', () => {
    state.language = locale;
    const poll = makePoll();
    state.messages = [pollMessage(poll), taskResult('completed', 3)];
    render(<ToolCallDisplay toolCall={poll} index={0} total={1} mediaContext={{ sessionId: 'history' }} />);
    expect(screen.getByTestId('tool-call-row-task_status').textContent).toContain(`${shortName}\u3000${running}`);
  });
});
