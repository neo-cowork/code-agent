// @vitest-environment jsdom
// Consecutive same-cause failed delegation cards fold to a grey line; only the newest stays red.

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, ToolCall } from '../../../src/shared/contract';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { projectSupersededDelegationFailures } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationFailureRuns';
import { deriveDelegationPresentation } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';

const mocks = vi.hoisted(() => ({
  tasks: [] as Task[],
  messages: [] as unknown[],
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: Task[] }) => unknown) => selector({ tasks: mocks.tasks }),
}));
vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: null, refresh: vi.fn() }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ currentSessionId: 'session-1', messages: mocks.messages }),
    { getState: () => ({ currentSessionId: 'session-1', switchSession: vi.fn() }) },
  ),
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign((selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      processingSessionIds: new Set<string>(),
      openPreview: vi.fn(),
      language: mocks.language,
      setLanguage: vi.fn(),
      cloudUIStrings: undefined,
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {},
    };
    return selector ? selector(state) : state;
  }, { getState: () => ({ language: mocks.language }) }),
}));

const RATE_LIMIT = 'HTTP 429: rate limit exceeded, please retry later';
const TIMEOUT_TEXT = 'the model request timed out after 120 seconds';

function call(n: number): ToolCall {
  return {
    id: `call-${n}`,
    name: 'delegate_task',
    arguments: { title: `打开示例页面 ${n}` },
    result: {
      toolCallId: `call-${n}`,
      success: true,
      output: 'accepted',
      metadata: { sessionTask: { outcome: 'accepted', tasks: [{ taskId: `task-${n}` }] } },
    },
  };
}

function task(n: number, status: Task['status'], message = RATE_LIMIT): Task {
  return {
    id: `task-${n}`,
    sessionId: 'session-1',
    toolCallId: `call-${n}`,
    source: 'delegate',
    title: `打开示例页面 ${n}`,
    status,
    createdAt: n * 1000,
    updatedAt: n * 1000 + 500,
    completedAt: n * 1000 + 500,
    events: [],
    outputRefs: [],
    ...(status === 'failed' ? { failure: { reason: 'task_failed', message } } : {}),
  } as unknown as Task;
}

function assistantCall(n: number): Message {
  return { id: `a-${n}`, role: 'assistant', content: '', timestamp: n * 1000, toolCalls: [call(n)] } as Message;
}
function userMsg(n: number): Message {
  return { id: `u-${n}`, role: 'user', content: `ask ${n}`, timestamp: n * 1000 - 10 } as Message;
}
function reply(n: number, ts: number): Message {
  return { id: `r-${n}`, role: 'assistant', content: '页面标题是 Example Domain', timestamp: ts } as Message;
}

function renderAll(count: number) {
  return render(<>{Array.from({ length: count }, (_, i) => (
    <ToolCallDisplay key={i} toolCall={call(i + 1)} index={0} total={1} />
  ))}</>);
}

function setup(tasks: Task[], messages: Message[]) {
  mocks.tasks = tasks;
  mocks.messages = messages;
}

beforeEach(() => { mocks.language = 'zh'; });
afterEach(cleanup);

const flow = (n: number) => [userMsg(n), assistantCall(n)];

describe('delegation failure fold', () => {
  it('3a: three consecutive same-cause failures keep one red card and two grey lines', () => {
    setup([task(1, 'failed'), task(2, 'failed'), task(3, 'failed')], [...flow(1), ...flow(2), ...flow(3)]);
    const view = renderAll(3);
    expect(view.getAllByTestId('delegation-failure')).toHaveLength(1);
    expect(view.getAllByTestId('delegation-failed-actions')).toHaveLength(1);
    expect(view.getAllByTestId('delegation-failure-superseded')).toHaveLength(2);
    expect(view.getAllByTestId('delegation-headline')).toHaveLength(3);
    // newest keeps the red card
    expect(view.getByTestId('delegation-failure').closest('[data-testid="delegation-receipt"]')?.parentElement?.textContent).toContain('打开示例页面 3');
  });

  it('3b: different causes are not folded', () => {
    setup([task(1, 'failed'), task(2, 'failed', TIMEOUT_TEXT)], [...flow(1), ...flow(2)]);
    const view = renderAll(2);
    expect(view.getAllByTestId('delegation-failure')).toHaveLength(2);
    expect(view.queryAllByTestId('delegation-failure-superseded')).toHaveLength(0);
  });

  it('3b: two different unrecognised (generic) failures are not folded', () => {
    setup([task(1, 'failed', '找不到文件 report.xlsx'), task(2, 'failed', '浏览器进程意外崩溃')], [...flow(1), ...flow(2)]);
    const view = renderAll(2);
    expect(view.getAllByTestId('delegation-failure')).toHaveLength(2);
    expect(view.getAllByTestId('delegation-failed-actions')).toHaveLength(2);
    expect(view.queryAllByTestId('delegation-failure-superseded')).toHaveLength(0);
  });

  it('3c: a completed delegation or a later successful reply resets the run', () => {
    setup([task(1, 'failed'), task(2, 'completed'), task(3, 'failed')], [...flow(1), ...flow(2), ...flow(3)]);
    let view = renderAll(3);
    expect(view.queryAllByTestId('delegation-failure-superseded')).toHaveLength(0);
    expect(view.getAllByTestId('delegation-failure')).toHaveLength(2);
    cleanup();

    setup([task(1, 'failed'), task(2, 'failed')], [...flow(1), reply(1, 1900), ...flow(2)]);
    view = renderAll(2);
    expect(view.queryAllByTestId('delegation-failure-superseded')).toHaveLength(0);
    expect(view.getAllByTestId('delegation-failure')).toHaveLength(2);
  });

  it('3c: an acknowledgement sent before the failure finished does not reset', () => {
    setup([task(1, 'failed'), task(2, 'failed')], [userMsg(1), assistantCall(1), reply(1, 1100), ...flow(2)]);
    const view = renderAll(2);
    expect(view.getAllByTestId('delegation-failure-superseded')).toHaveLength(1);
  });

  it('3d: a single failure is unchanged', () => {
    setup([task(1, 'failed')], flow(1));
    const view = renderAll(1);
    expect(view.getAllByTestId('delegation-failure')).toHaveLength(1);
    expect(view.getAllByTestId('delegation-failed-actions')).toHaveLength(1);
    expect(view.queryAllByTestId('delegation-failure-superseded')).toHaveLength(0);
  });

  it.each(['zh', 'en'] as const)('3e: grey line has no internal words (%s)', (language) => {
    mocks.language = language;
    setup([task(1, 'failed'), task(2, 'failed')], [...flow(1), ...flow(2)]);
    const view = renderAll(2);
    const line = view.getByTestId('delegation-failure-superseded');
    expect(line.textContent?.length).toBeGreaterThan(0);
    expect(line.textContent).not.toMatch(/deliverable|repair scope|rate_limited|failureCode|task-\d|call-\d|delegate_task/i);
    expect(line.className).not.toContain('danger');
    expect(line.querySelector('button')).toBeNull();
  });

  it('public projection returns the older ids and persists nothing', () => {
    const tasks = [task(1, 'failed'), task(2, 'failed'), task(3, 'failed')];
    const messages = [...flow(1), ...flow(2), ...flow(3)];
    const before = JSON.stringify(messages);
    const ids = projectSupersededDelegationFailures(messages, (c) => deriveDelegationPresentation(c, tasks, []));
    expect([...ids]).toEqual(['call-1', 'call-2']);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
