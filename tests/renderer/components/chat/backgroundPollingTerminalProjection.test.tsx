// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/shared/contract';
import type { Task } from '../../../../src/shared/contract/backgroundTask';
import type { TraceNode } from '../../../../src/shared/contract/trace';
import ipcService from '../../../../src/renderer/services/ipcService';
import { TraceNodeRenderer } from '../../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { ToolStepGroup } from '../../../../src/renderer/components/features/chat/ToolStepGroup';
import { AgentErrorPresentation } from '../../../../src/renderer/components/features/chat/AgentErrorCard';
import { projectTurns } from '../../../../src/renderer/hooks/useTurnProjection';
import { useAppStore } from '../../../../src/renderer/stores/appStore';
import { useBackgroundTaskStore } from '../../../../src/renderer/stores/backgroundTaskStore';
import { useSessionStore } from '../../../../src/renderer/stores/sessionStore';

const SESSION = 'polling-session';
function task(status: Task['status'] = 'completed', toolCallId = 'delegate'): Task {
  return { id: `task-${toolCallId}`, source: 'session_command_center', sessionId: SESSION, toolCallId,
    title: '运行项目测试', status, createdAt: 1, updatedAt: 5, events: [], outputRefs: [] };
}
function node(id = 'delegate', name = 'delegate_task', extra: Partial<NonNullable<TraceNode['toolCall']>> = {}): TraceNode {
  return { id: `node-${id}`, type: 'tool_call', content: '', timestamp: 2,
    toolCall: { id, name, args: { title: '运行项目测试', command: 'npm test', run_in_background: true }, ...extra } };
}
beforeEach(() => {
  useAppStore.setState({ language: 'zh', processingSessionIds: new Set(), pendingPermissionRequest: null, pendingPermissionSessionId: null, queuedPermissionRequests: {} });
  useSessionStore.setState({ currentSessionId: SESSION, messages: [], runningSessionIds: new Set() });
  useBackgroundTaskStore.setState({ tasks: [] });
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); useBackgroundTaskStore.setState({ tasks: [] }); });

describe('background polling terminal projection', () => {
  it.each([
    ['completed ledger', 'completed', undefined, false, false],
    ['running ledger', 'running', undefined, false, false],
    ['failed ledger', 'failed', undefined, true, false],
    ['real failure wins completed ledger', 'completed', false, true, false],
    ['real success wins failed ledger', 'failed', true, false, false],
    ['offline no result', undefined, undefined, false, true],
  ] as const)('%s settles both collapsed header and expanded rows', (_name, ledger, success, failed, interrupted) => {
    if (ledger) useBackgroundTaskStore.setState({ tasks: [task(ledger)] });
    render(<ToolStepGroup nodes={[node('delegate', 'Bash', success === undefined ? {} : { success, result: success ? 'passed' : 'test failed' })]} sessionId={SESSION} defaultExpanded />);
    const text = document.body.textContent ?? '';
    console.log('TERMINAL_TABLE_RAW', _name, text);
    expect(text.includes('已中断')).toBe(interrupted);
    if (!interrupted) expect(text.includes('未成功')).toBe(failed);
    expect(screen.queryAllByTestId('interrupt-timeline-step').length > 0).toBe(interrupted);
  });
  it.each(['completed', 'failed'] as const)('sub-agent %s uses the same agent-tree row source as the member bar', async (status) => {
    vi.spyOn(ipcService, 'invokeDomain').mockResolvedValue({
      generatedAt: 5, sessionId: SESSION, roots: [],
      nodes: [{ id: 'child', role: 'explore', status, statusLabel: status, children: [], sources: ['subagentContext'],
        worktreeState: { status: 'none' }, budgetSummary: {}, evidenceRefs: [] }],
      summary: { ownershipConflicts: [] },
    });
    const child = node('child-command', 'Bash');
    child.metadata = { agentTeam: { sessionId: SESSION, runId: 'child-run', treeId: 'tree', agentId: 'child' } };
    render(<ToolStepGroup nodes={[child]} sessionId={SESSION} defaultExpanded />);
    await waitFor(() => expect(document.body.textContent).not.toContain('已中断'));
    expect(document.body.textContent?.includes('未成功')).toBe(status === 'failed');
    console.log('SUBAGENT_ROW_RAW', status, document.body.textContent);
  });
  it('a completed agent unrelated to the call cannot settle it', async () => {
    vi.spyOn(ipcService, 'invokeDomain').mockResolvedValue({ generatedAt: 5, roots: [],
      nodes: [{ id: 'other', role: 'explore', status: 'completed', children: [], sources: ['subagentContext'],
        worktreeState: { status: 'none' }, budgetSummary: {}, evidenceRefs: [] }], summary: { ownershipConflicts: [] } });
    render(<ToolStepGroup nodes={[node('own-command', 'Bash')]} sessionId={SESSION} defaultExpanded />);
    await waitFor(() => expect(screen.getByTestId('interrupt-timeline-step')).toBeTruthy());
  });
  it('shape a: lone delegate without result settles from its completed ledger', () => {
    useBackgroundTaskStore.setState({ tasks: [task()] });
    render(<ToolStepGroup nodes={[node()]} sessionId={SESSION} />);
    console.log('SHAPE_A_RAW', document.body.textContent);
    expect(document.body.textContent).not.toMatch(/已中断|未成功/);
    expect(document.body.textContent).toContain('运行项目测试');
  });
  it('shape b: collapsed header single visible delegate agrees with expanded rows after completed Bash placeholder hides', () => {
    useBackgroundTaskStore.setState({ tasks: [task(), { ...task('completed', 'bash'), source: 'shell', kind: 'shell' }] });
    render(<ToolStepGroup nodes={[node(), node('bash', 'Bash')]} sessionId={SESSION} />);
    const header = screen.getByTestId('tool-group-head-label');
    console.log('COLLAPSED_HEADER_RAW', header.textContent);
    expect(header.textContent).not.toMatch(/已中断|未成功/);
    fireEvent.click(header.closest('button')!);
    console.log('EXPANDED_ROWS_RAW', document.body.textContent);
    expect(document.body.textContent).not.toMatch(/已中断|未成功/);
  });
  it('awaiting approval stays pending while the session is offline', () => {
    useAppStore.setState({ pendingPermissionSessionId: SESSION, pendingPermissionRequest: { id: 'approval', tool: 'Bash', parentToolUseId: 'delegate', details: {} } as never });
    render(<ToolStepGroup nodes={[node('delegate', 'Bash')]} sessionId={SESSION} defaultExpanded />);
    expect(document.body.textContent).not.toContain('已中断');
  });
  it('shape c: three polling handbacks with wake users and intervening assistant content leave at most one full same-reason card', () => {
    const messages: Message[] = [{ id: 'user', role: 'user', content: '后台运行项目测试，帮我看三次进度。', timestamp: 1 }];
    for (let i = 1; i <= 3; i++) {
      messages.push({ id: `poll-${i}`, role: 'assistant', content: '', timestamp: i * 10,
        toolCalls: [{ id: `check-${i}`, name: 'task_status', arguments: {} }] });
      messages.push({ id: `failure-${i}`, role: 'assistant', content: '已达本任务的最大步骤上限。', timestamp: i * 10 + 1,
        metadata: { agentError: { category: 'generic', code: 'MAX_ITERATIONS_REACHED', rawMessage: 'Max iterations reached', timestamp: i * 10 + 1 } } });
      if (i < 3) messages.push({ id: `wake-${i}`, role: 'user', content: '后台任务进度更新。', timestamp: i * 10 + 2, isMeta: true,
        metadata: { backgroundTaskResult: { source: 'agent-result', taskId: 'task-delegate', shortName: '项目测试', status: 'unverified', summary: '仍在运行' } } });
      if (i === 1) messages.push({ id: 'progress', role: 'assistant', content: '项目测试仍在进行，稍后我会继续查看。', timestamp: 13 });
    }
    const nodes = projectTurns(messages, SESSION, false).turns.flatMap(turn => turn.nodes);
    render(<>{nodes.filter(n => n.metadata?.agentError).map(n => <AgentErrorPresentation key={n.id} error={n.metadata!.agentError!} messageId={n.messageId ?? n.id} sessionId={SESSION} run={n.agentErrorRun} />)}</>);
    console.log('POLL_FAILURE_CARDS_RAW', screen.queryAllByRole('alert').length);
    expect(screen.queryAllByRole('alert').length).toBeLessThanOrEqual(1);
  });
  it('real user Stop with an unrelated completed task in the turn preserves the stopped row', () => {
    useBackgroundTaskStore.setState({ tasks: [task('completed', 'unrelated')] });
    const messages: Message[] = [
      { id: 'user', role: 'user', content: '检查项目', timestamp: 1 },
      { id: 'stop', role: 'assistant', content: '[cancelled]', timestamp: 3, metadata: { streamInterruptionReason: 'user' } },
    ];
    const nodes = projectTurns(messages, SESSION, false).turns.flatMap(turn => turn.nodes);
    console.log('REAL_STOP_RAW', JSON.stringify(nodes));
    expect(nodes.some(n => n.metadata?.streamInterruptionReason === 'user')).toBe(true);
    render(<>{nodes.map(n => <TraceNodeRenderer key={n.id} node={n} sessionId={SESSION} />)}</>);
    expect(document.body.textContent).toContain('你停止了这次执行');
  });
  it('consumers delegate terminal decisions and contain no local stale derivation', () => {
    const root = 'src/renderer/';
    for (const file of ['components/features/chat/ToolStepGroup.tsx', 'components/features/chat/TraceNodeRenderer.tsx', 'components/features/chat/MessageBubble/ToolCallDisplay/styles.ts', 'components/features/chat/MessageBubble/ToolCallDisplay/index.tsx', 'utils/bareInterruptionNode.ts']) {
      const text = readFileSync(`${root}${file}`, 'utf8');
      expect(text, file).toMatch(/resolveToolCallTerminalState|getToolStatus|traceTerminalToolCall/);
      expect(text, file).not.toMatch(/isStaleUnfinishedToolCall|return isProcessing \? 'pending' : 'interrupted'|\.result\s*===\s*undefined[^;\n]*['"]interrupted['"]|toolCall\.result === undefined && !sessionLive/);
    }
  });
});
