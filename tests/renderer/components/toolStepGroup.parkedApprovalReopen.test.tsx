// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { ParkedApprovalInboxItem } from '../../../src/shared/contract/pendingApproval';

const listParkedApprovals = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: { listParkedApprovals },
  default: { listParkedApprovals },
}));

import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { refreshParkedApprovals } from '../../../src/renderer/stores/parkedApprovalStore';

// 重开的会话：会话在线（processingSessionIds 含它）、没有内存 permission request，
// 审批只在 pending_approvals 表里（listParkedApprovals 的真实条目形状，含 toolCallId）。

const SESSION = 'sess-parked';

function parkedItem(toolCallId: string | undefined, tool = 'Write'): ParkedApprovalInboxItem {
  return {
    id: `req-${toolCallId ?? 'legacy'}`,
    kind: 'tool_approval',
    sessionId: SESSION,
    ...(toolCallId ? { toolCallId } : {}),
    tool,
    requestedAt: 1_000,
    status: 'pending',
    riskClass: null,
    standingGrantTarget: null,
  };
}

function node(id: string, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): TraceNode {
  return {
    id: `n-${id}`, type: 'tool_call', content: '', timestamp: 1,
    toolCall: { id, name, args, ...extra },
  } as TraceNode;
}

const writeNode = (extra: Record<string, unknown> = {}) => node('call-w', 'Write', { file_path: '/out/rr30-out.txt', content: 'x' }, extra);
const bashNode = (extra: Record<string, unknown> = {}) => node('call-b', 'Bash', { command: 'echo hi' }, extra);
const head = () => screen.getByTestId('tool-group-head-label').textContent ?? '';

describe('重开会话：落库停车审批在折叠头与行上都说「等你确认」', () => {
  beforeEach(async () => {
    listParkedApprovals.mockReset();
    listParkedApprovals.mockResolvedValue([]);
    await refreshParkedApprovals();
    useSessionStore.setState({ currentSessionId: SESSION });
  });
  afterEach(() => {
    cleanup();
    useAppStore.setState({ processingSessionIds: new Set<string>(), isProcessing: false });
    useSessionStore.setState({ currentSessionId: null });
  });

  const live = (language: 'zh' | 'en') => useAppStore.setState({
    language, processingSessionIds: new Set([SESSION]), isProcessing: true,
  });

  it.each([
    ['zh', 'Write', writeNode, '请求写入', '待确认', '正在写入', '运行中'],
    ['zh', 'Bash', bashNode, '请求运行命令', '待确认', '正在运行命令', '运行中'],
    ['en', 'Write', writeNode, 'Request to', 'Approval needed', 'Writing', 'Running'],
    ['en', 'Bash', bashNode, 'Request to', 'Approval needed', 'Running', 'Running'],
  ] as const)('① %s %s：折叠头 + 展开行是待确认形态，不是进行时', async (lang, tool, make, pendingWord, statusWord, runningVerb, runningWord) => {
    live(lang);
    listParkedApprovals.mockResolvedValue([parkedItem(tool === 'Write' ? 'call-w' : 'call-b', tool)]);
    render(<ToolStepGroup nodes={[make()]} sessionId={SESSION} defaultExpanded />);
    await waitFor(() => expect(head()).toContain(pendingWord));
    expect(head()).not.toContain(runningWord);
    expect(head()).not.toContain(runningVerb);
    const row = screen.getByTestId(`tool-call-row-${tool}`).textContent ?? '';
    expect(row).toContain(statusWord);
    expect(row).not.toContain(runningVerb);
  });

  it('① ToolCallDisplay 单独渲染也走同一来源（真 hook + mock IPC）', async () => {
    live('zh');
    listParkedApprovals.mockResolvedValue([parkedItem('call-w')]);
    render(<ToolCallDisplay toolCall={{ id: 'call-w', name: 'Write', arguments: { file_path: '/out/a.txt', content: 'x' } }} index={0} total={1} />);
    await waitFor(() => expect(screen.getByTestId('tool-call-row-Write').textContent).toContain('待确认'));
    expect(screen.getByTestId('tool-call-row-Write').textContent).not.toContain('正在写入');
  });

  it('② 批准后：停车行消失 → 折叠头回到执行中', async () => {
    live('zh');
    listParkedApprovals.mockResolvedValue([parkedItem('call-w')]);
    render(<ToolStepGroup nodes={[writeNode()]} sessionId={SESSION} />);
    await waitFor(() => expect(head()).toContain('请求写入'));
    listParkedApprovals.mockResolvedValue([]);
    await act(async () => { await refreshParkedApprovals(); });
    expect(head()).not.toContain('请求写入');
    expect(head()).toContain('正在写入');
  });

  it('② 拒绝：台账写入失败结果 → 终态，不再显示待确认/运行中', async () => {
    live('zh');
    listParkedApprovals.mockResolvedValue([]);
    render(<ToolStepGroup nodes={[writeNode({ success: false, result: '用户拒绝' })]} sessionId={SESSION} />);
    expect(head()).not.toMatch(/请求写入|运行中|正在写入/);
  });

  it('② 作废：result 已有时，即使列表里还残留该 id 也不算待确认', async () => {
    live('zh');
    listParkedApprovals.mockResolvedValue([parkedItem('call-w')]);
    await act(async () => { await refreshParkedApprovals(); });
    render(<ToolStepGroup nodes={[writeNode({ success: false, result: '这一步等你确认超过 24 小时，已自动作废，没有执行。' })]} sessionId={SESSION} />);
    expect(head()).not.toMatch(/请求写入|运行中|正在写入/);
  });

  it('② 行没有 toolCallId（老行）→ 保持原行为：仍按运行中渲染', async () => {
    live('zh');
    listParkedApprovals.mockResolvedValue([parkedItem(undefined)]);
    render(<ToolStepGroup nodes={[writeNode()]} sessionId={SESSION} />);
    await waitFor(() => expect(listParkedApprovals).toHaveBeenCalled());
    expect(head()).toContain('正在写入');
    expect(head()).not.toContain('请求写入');
  });
});
