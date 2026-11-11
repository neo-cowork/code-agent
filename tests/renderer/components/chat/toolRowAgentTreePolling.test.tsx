// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../../src/shared/contract';
import type { TraceNode } from '../../../../src/shared/contract/trace';
import { IPC_DOMAINS } from '../../../../src/shared/ipc';
import ipcService from '../../../../src/renderer/services/ipcService';
import { ToolStepGroup } from '../../../../src/renderer/components/features/chat/ToolStepGroup';
import { ToolCallDisplay } from '../../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { useAppStore } from '../../../../src/renderer/stores/appStore';
import { useBackgroundTaskStore } from '../../../../src/renderer/stores/backgroundTaskStore';
import { useSessionStore } from '../../../../src/renderer/stores/sessionStore';

const SESSION = 'history-session';
const ROWS = 20;
const POLL_MS = 3000;

function traceNode(i: number, settled: boolean, agentId?: string): TraceNode {
  return { id: `node-${i}`, type: 'tool_call', content: '', timestamp: i + 1,
    metadata: agentId ? { agentTeam: { sessionId: SESSION, runId: 'child-run', treeId: 'tree', agentId } } : undefined,
    toolCall: { id: `group-call-${i}`, name: 'Bash', args: { command: `echo ${i}` }, ...(settled ? { result: 'ok', success: true } : {}) } };
}
function toolCall(i: number, settled: boolean, name = 'Bash'): ToolCall {
  return { id: `row-call-${i}`, name, arguments: { command: `echo ${i}` },
    result: settled ? { toolCallId: `row-call-${i}`, success: true, output: 'ok' } : undefined };
}
function treeCalls(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter(([domain, action]) => domain === IPC_DOMAINS.AGENT && action === 'getTree').length;
}
function spyTree(status = 'completed') {
  return vi.spyOn(ipcService, 'invokeDomain').mockImplementation(((domain: string, action: string) => Promise.resolve(
    domain === IPC_DOMAINS.AGENT && action === 'getTree' ? { generatedAt: 5, sessionId: SESSION, roots: [],
      nodes: [{ id: 'child', role: 'explore', status, statusLabel: status, children: [], sources: ['subagentContext'],
        worktreeState: { status: 'none' }, budgetSummary: {}, evidenceRefs: [] }],
      summary: { ownershipConflicts: [] } } : null)) as never);
}
async function tick(times: number) {
  for (let i = 0; i < times; i++) await act(async () => { vi.advanceTimersByTime(POLL_MS); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  useAppStore.setState({ language: 'zh', processingSessionIds: new Set(), pendingPermissionRequest: null, pendingPermissionSessionId: null, queuedPermissionRequests: {} });
  useSessionStore.setState({ currentSessionId: SESSION, messages: [], runningSessionIds: new Set() });
  useBackgroundTaskStore.setState({ tasks: [] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('tool rows share one agent-tree poll per session', () => {
  it.each([
    ['settled', true],
    ['result-less main-session (historical interrupted)', false],
  ] as const)(`${ROWS} %s ToolStepGroup + ToolCallDisplay rows start no agent-tree poll`, async (_name, settled) => {
    const spy = spyTree();
    render(<>
      <ToolStepGroup nodes={Array.from({ length: ROWS }, (_, i) => traceNode(i, settled))} sessionId={SESSION} defaultExpanded />
      {Array.from({ length: ROWS }, (_, i) => <ToolStepGroup key={`g${i}`} nodes={[traceNode(100 + i, settled)]} sessionId={SESSION} />)}
      {Array.from({ length: ROWS }, (_, i) => <ToolCallDisplay key={`r${i}`} toolCall={toolCall(i, settled)} index={i} total={ROWS} />)}
    </>);
    await tick(3);
    console.log('AGENT_TREE_POLLS_RAW', _name, 'rows', ROWS * 3, 'getTree', treeCalls(spy));
    expect(treeCalls(spy)).toBe(0);
  });

  it(`${ROWS} result-less agent-owned rows share one poll, still settle from the agent row, and stop on unmount`, async () => {
    const spy = spyTree('completed');
    const view = render(<>
      {Array.from({ length: ROWS }, (_, i) => <ToolStepGroup key={`g${i}`} nodes={[traceNode(i, false, 'child')]} sessionId={SESSION} defaultExpanded />)}
    </>);
    await waitFor(() => expect(document.body.textContent).not.toContain('已中断'));
    console.log('AGENT_TREE_POLLS_RAW', 'agent-owned mount', 'getTree', treeCalls(spy));
    expect(treeCalls(spy)).toBe(1);
    await tick(3);
    console.log('AGENT_TREE_POLLS_RAW', 'agent-owned after 3 intervals', 'getTree', treeCalls(spy));
    expect(treeCalls(spy)).toBe(4);
    view.unmount();
    await tick(3);
    expect(treeCalls(spy)).toBe(4);
  });

  it(`${ROWS} dispatch rows that read the agent tree share one poll`, async () => {
    const spy = spyTree('running');
    render(<>{Array.from({ length: ROWS }, (_, i) => <ToolCallDisplay key={i} toolCall={toolCall(i, true, 'spawn_agent')} index={i} total={ROWS} />)}</>);
    await tick(3);
    console.log('AGENT_TREE_POLLS_RAW', 'dispatch rows', 'getTree', treeCalls(spy));
    expect(treeCalls(spy)).toBe(4);
  });
});
