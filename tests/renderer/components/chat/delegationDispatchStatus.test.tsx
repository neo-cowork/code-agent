// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../../src/shared/contract';
import type { AgentTreeNodeStatus } from '../../../../src/shared/contract/agentTree';
import type { Task } from '../../../../src/shared/contract/backgroundTask';
import type { TraceNode } from '../../../../src/shared/contract/trace';
import { IPC_DOMAINS } from '../../../../src/shared/ipc';
import ipcService from '../../../../src/renderer/services/ipcService';
import { ToolStepGroup } from '../../../../src/renderer/components/features/chat/ToolStepGroup';
import { ToolCallDisplay } from '../../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { useAppStore } from '../../../../src/renderer/stores/appStore';
import { useBackgroundTaskStore } from '../../../../src/renderer/stores/backgroundTaskStore';
import { useSessionStore } from '../../../../src/renderer/stores/sessionStore';

const SESSION = 'dispatch-session';
const AGENT = 'agent_explore_1';
const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
type Icon = 'spinner' | 'success' | 'error';

function task(status: Task['status']): Task {
  return { id: 'task-1', source: 'session_command_center', sessionId: SESSION, toolCallId: 'delegate-call',
    title: '核对发布清单', status, createdAt: 1, updatedAt: 5, events: [], outputRefs: [] };
}
// The result of a delegation call is the dispatch receipt, not the outcome of the delegated work.
function delegateCall(result: Partial<NonNullable<ToolCall['result']>> = {}): ToolCall {
  return { id: 'delegate-call', name: 'delegate_task', arguments: { description: '核对发布清单' },
    result: { toolCallId: 'delegate-call', success: true, output: 'accepted', ...result } };
}
function spawnCall(): ToolCall {
  return { id: 'spawn-call', name: 'spawn_agent', arguments: { role: 'explore', task: '核对发布清单', run_in_background: true },
    result: { toolCallId: 'spawn-call', success: true, output: `- Agent ID: ${AGENT}`, metadata: { agentId: AGENT } } };
}
function spyTree(status: AgentTreeNodeStatus) {
  vi.spyOn(ipcService, 'invokeDomain').mockImplementation(((domain: string, action: string) => Promise.resolve(
    domain === IPC_DOMAINS.AGENT && action === 'getTree' ? { generatedAt: 5, sessionId: SESSION, roots: [],
      nodes: [{ id: AGENT, role: 'explore', status, statusLabel: status, children: [], sources: ['spawnGuard'],
        worktreeState: { status: 'none' }, budgetSummary: {}, evidenceRefs: [] }],
      summary: { ownershipConflicts: [] } } : null)) as never);
}
/** The row's own status icon: the first cell of the row, ahead of the title. */
function icon(toolName: string): Icon {
  const text = screen.getByTestId(`tool-call-row-${toolName}`).firstElementChild?.textContent ?? '';
  return SPINNER.test(text) ? 'spinner' : text === '✗' ? 'error' : text === '●' ? 'success' : (`unexpected:${text}` as Icon);
}

beforeEach(() => {
  useAppStore.setState({ language: 'zh', processingSessionIds: new Set(), pendingPermissionRequest: null, pendingPermissionSessionId: null, queuedPermissionRequests: {} });
  useSessionStore.setState({ currentSessionId: SESSION, messages: [], runningSessionIds: new Set() });
  useBackgroundTaskStore.setState({ tasks: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); useBackgroundTaskStore.setState({ tasks: [] }); });

describe('a dispatched delegation row follows the delegated work, not the dispatch receipt', () => {
  it.each([
    ['running', 'spinner'],
    ['queued', 'spinner'],
    ['failed', 'error'],
    ['cancelled', 'error'],
    ['completed', 'success'],
  ] as const)('background task %s after a successful dispatch shows %s', (status, expected) => {
    useBackgroundTaskStore.setState({ tasks: [task(status)] });
    render(<ToolCallDisplay toolCall={delegateCall()} index={0} total={1} />);
    console.log('DISPATCH_ROW_RAW', 'delegate_task', status, icon('delegate_task'), '|', screen.getByTestId('tool-call-row-delegate_task').textContent);
    expect(icon('delegate_task')).toBe(expected);
  });

  it.each([
    ['running', 'spinner'],
    ['failed', 'error'],
    ['completed', 'success'],
  ] as const)('sub-agent %s after a successful dispatch shows %s', async (status, expected) => {
    spyTree(status);
    render(<ToolCallDisplay toolCall={spawnCall()} index={0} total={1} />);
    await waitFor(() => expect(icon('spawn_agent')).toBe(expected));
    console.log('DISPATCH_ROW_RAW', 'spawn_agent', status, icon('spawn_agent'), '|', screen.getByTestId('tool-call-row-spawn_agent').textContent);
  });

  it.each([
    ['running', 'spinner'],
    ['failed', 'error'],
  ] as const)('the same row reached through ToolStepGroup shows %s work as %s', (status, expected) => {
    useBackgroundTaskStore.setState({ tasks: [task(status)] });
    const node: TraceNode = { id: 'node-delegate', type: 'tool_call', content: '', timestamp: 2,
      toolCall: { id: 'delegate-call', name: 'delegate_task', args: { description: '核对发布清单' }, result: 'accepted', success: true } };
    render(<ToolStepGroup nodes={[node]} sessionId={SESSION} />);
    console.log('DISPATCH_ROW_RAW', 'group', status, icon('delegate_task'));
    expect(icon('delegate_task')).toBe(expected);
  });

  it('with no record of the delegated work yet, the dispatch receipt still decides', () => {
    render(<ToolCallDisplay toolCall={delegateCall()} index={0} total={1} />);
    expect(icon('delegate_task')).toBe('success');
    cleanup();
    render(<ToolCallDisplay toolCall={delegateCall({ success: false, output: undefined, error: 'dispatch rejected' })} index={0} total={1} />);
    // A plain failed call renders the quiet failure style: muted dot plus the failure rail on the row wrapper.
    expect(screen.getByTestId('tool-call-row-delegate_task').parentElement?.className).toContain('border-l-2');
  });

  it('a receipt row keeps its own failed outcome even when the call was later recovered', () => {
    const toolCall: ToolCall = { id: 'mail-call', name: 'mail_send', arguments: { to: 'a@example.com' },
      result: { toolCallId: 'mail-call', success: false, error: 'send rejected', metadata: { recovered: true } } };
    render(<ToolCallDisplay toolCall={toolCall} index={0} total={1}
      receipt={{ status: 'failed', sourceTool: 'mail_send', createdAt: 1 }} />);
    const row = screen.getByTestId('tool-call-row-mail_send');
    console.log('RECEIPT_ROW_RAW', row.parentElement?.className.includes('border-l-2') ? 'failed-rail' : 'no-rail', '|', row.textContent,
      '| recovered-note', screen.queryAllByTestId('tool-call-recovered-note').length);
    expect(row.textContent).toContain('失败');
    expect(row.parentElement?.className).toContain('border-l-2');
    expect(screen.queryByTestId('tool-call-recovered-note')).toBeNull();
  });

  it('a failure already recovered by a later success stays settled', () => {
    useBackgroundTaskStore.setState({ tasks: [task('failed')] });
    render(<ToolCallDisplay toolCall={delegateCall({ success: false, output: undefined, error: 'first try failed', metadata: { recovered: true } })} index={0} total={1} />);
    expect(icon('delegate_task')).toBe('success');
  });
});
