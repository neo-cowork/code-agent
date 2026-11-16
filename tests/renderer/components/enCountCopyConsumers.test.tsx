// @vitest-environment jsdom
// English count copy through the real consumers (not just the bundles):
// step-summary group label, completed background card, archive manifest marker,
// and the progress-summary joiners.
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest, ToolCall } from '../../../src/shared/contract';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { en } from '../../../src/renderer/i18n/en';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: en, language: 'en' }) }));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({
      processingSessionIds: new Set(),
      openPreview: vi.fn(),
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: [],
      resolvedPermissionRequests: {} as Record<string, PermissionRequest[]>,
    }),
    { getState: () => ({ language: 'en' as const }) },
  ),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector({ currentSessionId: 'session-1', messages: [], sessions: [], hasOlderSessions: false }),
}));
vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: [] }) => unknown) => selector({ tasks: [] }),
}));
vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: null, refresh: vi.fn() }),
}));

import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { humanizeToolGroupLabel } from '../../../src/renderer/utils/humanizeToolStep';
import { DelegationReceipt } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/DelegationReceipt';
import { deriveDelegationPresentation } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';

afterEach(cleanup);

function runningNode(id: string, name: string, args: Record<string, unknown>): TraceNode {
  return { id: `node-${id}`, type: 'tool_call', content: '', timestamp: 1, toolCall: { id, name, args } } as TraceNode;
}
function doneNode(id: string, name: string, args: Record<string, unknown>, success: boolean): TraceNode {
  return { id: `node-${id}`, type: 'tool_call', content: '', timestamp: 1, toolCall: { id, name, args, success, result: success ? 'ok' : 'boom' } } as TraceNode;
}

describe('English step-summary label at count 1 vs 2 (ToolStepGroup)', () => {
  it('running group header: 1 running command is singular, 2 are plural', () => {
    const read = doneNode('r', 'Read', { file_path: '/tmp/a.txt' }, true);
    const one = renderToStaticMarkup(<ToolStepGroup nodes={[runningNode('a', 'Bash', { command: 'ls' }), read]} sessionId="session-1" isStreamingTurn />);
    expect(one).toContain('Running 1 command');
    expect(one).not.toMatch(/\b1 (steps|commands|times)\b/);
    const two = renderToStaticMarkup(<ToolStepGroup
      nodes={[runningNode('a', 'Bash', { command: 'ls' }), runningNode('b', 'Bash', { command: 'pwd' }), read]}
      sessionId="session-1"
      isStreamingTurn
    />);
    expect(two).toContain('Running 2 commands');
  });

  it.each([
    ['running', 'Running 1 command', 'Running 2 commands'],
    ['pending-approval', 'Request to run 1 command', 'Request to run 2 commands'],
    ['failed', 'Could not run 1 command', 'Could not run 2 commands'],
    ['completed', 'Ran 1 command', 'Ran 2 commands'],
  ] as const)('humanizeToolGroupLabel %s', (status, one, two) => {
    expect(humanizeToolGroupLabel(['Bash'], en, status)).toBe(one);
    expect(humanizeToolGroupLabel(['Bash', 'Bash'], en, status)).toBe(two);
  });

  it('inspection singular uses "1 time"', () => {
    expect(humanizeToolGroupLabel(['Read'], en, 'running')).toBe('Inspecting content 1 time');
    expect(humanizeToolGroupLabel(['Read', 'Read'], en, 'running')).toBe('Inspecting content 2 times');
  });
});

describe('English progress-summary joiners (ToolStepGroup, mixed statuses)', () => {
  it('uses ", " between buckets and "; " between status groups, no CJK punctuation', () => {
    const nodes = [
      doneNode('a', 'Bash', { command: 'ls' }, true),
      doneNode('b', 'Read', { file_path: '/tmp/a.txt' }, true),
      doneNode('c', 'Bash', { command: 'false' }, false),
    ];
    const html = renderToStaticMarkup(<ToolStepGroup nodes={nodes} sessionId="session-1" defaultExpanded />);
    expect(html).not.toMatch(/[、，；]/);
    expect(html).toContain('Ran 1 command, Looked at content 1 time');
    expect(html).toMatch(/Could not run 1 command/);
    expect(html).toContain('; ');
  });
});

describe('completed background card (DelegationReceipt, production consumer)', () => {
  const call: ToolCall = {
    id: 'call-1', name: 'delegate_task', arguments: { task: 'Summarize notes' },
    result: { toolCallId: 'call-1', success: true, output: 'Task task-1 dispatched' },
  };
  function task(current: number): Task {
    return {
      id: 'task-1', toolCallId: 'call-1', sessionId: 'session-1', source: 'delegate_task', title: 'Summarize notes',
      summary: 'Done', status: 'completed', createdAt: 1, updatedAt: 2, events: [], outputRefs: [],
      progress: { current, lastToolStep: { tool: 'Read', at: 2 } },
    } as Task;
  }
  it.each([[1, 'Completed 1 step'], [2, 'Completed 2 steps']])('%i step(s) -> %s', (count, text) => {
    const presentation = deriveDelegationPresentation(call, [task(count)], []);
    render(<DelegationReceipt presentation={presentation!} />);
    expect(screen.getByTestId('delegation-receipt').textContent).toContain(text);
    expect(screen.getByTestId('delegation-receipt').textContent).not.toMatch(/Completed 1 steps/);
  });
});
