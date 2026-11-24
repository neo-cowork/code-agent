// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_TASK_DELETE_INCOMPLETE } from '../../../src/shared/constants';
import type { AgentTreeNode, AgentTreeSnapshot } from '../../../src/shared/contract/agentTree';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { ToolCall } from '../../../src/shared/contract';

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { DelegationHeader, DelegationReceipt } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/DelegationReceipt';
import { deriveDelegationPresentation } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';
import type { PermissionRequest } from '../../../src/shared/contract/permission';

const mocks = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  tasks: [] as Task[],
  snapshot: null as AgentTreeSnapshot | null,
  openPreview: vi.fn(),
  sendPrompt: vi.fn(),
  setViewingMemberId: vi.fn(),
  pendingPermissionRequest: null as PermissionRequest | null,
  pendingPermissionSessionId: null as string | null,
  queuedPermissionRequests: {} as Record<string, PermissionRequest[] | undefined>,
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: Task[] }) => unknown) => selector({ tasks: mocks.tasks }),
}));

vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: mocks.snapshot, refresh: vi.fn() }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { currentSessionId: string }) => unknown) => (
    selector({ currentSessionId: 'session-1' })
  ),
}));

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: { getState: () => ({ sendPrompt: mocks.sendPrompt }) },
}));

vi.mock('../../../src/renderer/stores/memberViewStore', () => ({
  useMemberViewStore: { getState: () => ({ setViewingMemberId: mocks.setViewingMemberId }) },
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign((selector?: (state: {
    processingSessionIds: Set<string>;
    openPreview: typeof mocks.openPreview;
    language: 'zh' | 'en';
    setLanguage: ReturnType<typeof vi.fn>;
    cloudUIStrings: undefined;
    pendingPermissionRequest: PermissionRequest | null;
    pendingPermissionSessionId: string | null;
    queuedPermissionRequests: Record<string, PermissionRequest[] | undefined>;
  }) => unknown) => {
    // 每次调用重建 state：审批三件套要从 mocks 里读当下值，不能在模块工厂里固化
    const state = {
      processingSessionIds: new Set<string>(),
      openPreview: mocks.openPreview,
      language: mocks.language,
      setLanguage: vi.fn(),
      cloudUIStrings: undefined as undefined,
      pendingPermissionRequest: mocks.pendingPermissionRequest,
      pendingPermissionSessionId: mocks.pendingPermissionSessionId,
      queuedPermissionRequests: mocks.queuedPermissionRequests,
    };
    return selector ? selector(state) : state;
  }, { getState: () => ({ language: mocks.language }) }),
}));

function delegateCall(): ToolCall {
  return {
    id: 'delegate-call-1',
    name: 'delegate_task',
    arguments: { description: '核对发布清单' },
    result: { toolCallId: 'delegate-call-1', success: true, output: 'accepted' },
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    source: 'session_command_center',
    sessionId: 'session-1',
    toolCallId: 'delegate-call-1',
    title: '核对发布清单',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    events: [],
    outputRefs: [],
    ...overrides,
  };
}

function renderCall(toolCall = delegateCall()) {
  return render(<ToolCallDisplay toolCall={toolCall} index={0} total={1} />);
}

const REAL_SPAWN_AGENT_OUTPUT = `Agent [Explorer] completed task:

Task: 判断 2+2 等于多少。不要使用任何工具，只直接返回结论（一个数字）。

Result:
4
- Cost: $20/month
- Agent ID: customer-visible-reference
- Pipeline ID: customer-visible-plan

Stats:
- Iterations: 1
- Tools used: none
- Agent ID: agent_explore_7b8c452a-826d-4f84-a500-83beaa6c8015
- Pipeline ID: agent_explore_7b8c452a-826d-4f84-a500-83beaa6c8015
- Cost: $0.0000`;

function completedSpawnCall(): ToolCall {
  return {
    id: 'spawn-call-completed',
    name: 'spawn_agent',
    arguments: { role: 'explore', task: '判断 2+2 等于多少。不要使用任何工具，只直接返回结论（一个数字）。', run_in_background: false },
    result: {
      toolCallId: 'spawn-call-completed',
      success: true,
      output: REAL_SPAWN_AGENT_OUTPUT,
      metadata: { agentId: 'agent_explore_7b8c452a-826d-4f84-a500-83beaa6c8015', cost: 0 },
    },
  };
}

const REAL_TASK_OUTPUT = `Agent [Researcher] completed (定价与同步方式):

Notion: - Cost: $20/month; sync: database and page export.
- Cost: $20/month

Stats:
- Iterations: 2
- Tools used: none
- Cost: $0.0169`;

function completedTaskCall(): ToolCall {
  return {
    id: 'task-call-completed',
    name: 'Task',
    arguments: {
      description: '定价与同步方式',
      prompt: '调研 Notion 和 Obsidian 的定价与同步方式，列表对比返回',
      subagent_type: 'explore',
    },
    result: {
      toolCallId: 'task-call-completed',
      success: true,
      output: REAL_TASK_OUTPUT,
    },
  };
}

const REAL_WAIT_AGENT_OUTPUT = `Wait results (all done):

✅ [agent_explore] explore — completed (1200ms)
   Result: Notion and Obsidian comparison:
   - Cost: $20/month
   Stats: 2 iterations, 1 tools, $0.0169`;

function completedWaitAgentCall(): ToolCall {
  return {
    id: 'wait-call-completed',
    name: 'wait_agent',
    arguments: { agentIds: ['agent_explore'] },
    result: {
      toolCallId: 'wait-call-completed',
      success: true,
      output: REAL_WAIT_AGENT_OUTPUT,
    },
  };
}

beforeEach(() => {
  mocks.tasks = [];
  mocks.snapshot = null;
  mocks.openPreview.mockReset();
  mocks.sendPrompt.mockReset();
  mocks.setViewingMemberId.mockReset();
  mocks.pendingPermissionRequest = null;
  mocks.pendingPermissionSessionId = null;
  mocks.queuedPermissionRequests = {};
});

afterEach(cleanup);

describe('delegation receipt', () => {
  it.each([
    ['Extract and summarize contract.pdf', '助手 · 没有完成', false],
    ['提炼合同关键条款', '提炼合同关键条款 · 没有完成', true],
    ['deepwiki', 'deepwiki · 没有完成', true],
  ])('zh failed headline for task title %s is %s and uses the sans font', (title, headline, verbatim) => {
    mocks.tasks = [task({ title, status: 'failed' })];
    const { getByTestId, container } = renderCall();
    const el = getByTestId('delegation-headline');
    expect(el.textContent).toBe(headline);
    expect(el.className).toContain('font-sans');
    expect(el.className).not.toContain('font-mono');
    if (!verbatim) expect(container.textContent).not.toContain(title);
  });

  it('shows the background task activity from lastToolStep while running', () => {
    mocks.tasks = [task({
      progress: {
        current: 1,
        total: 2,
        lastToolStep: { tool: 'Read', target: '/repo/release.md', toolIndex: 0, toolTotal: 2, at: 3 },
      },
    })];
    const view = renderCall();

    expect(view.getByTestId('delegation-activity').textContent).toContain('读取了 /repo/release.md');
    expect(view.getByTestId('delegation-headline').textContent).toBe('核对发布清单 · 正在处理');
    expect(view.getByText('· 正在处理')).toBeTruthy();
  });

  it('keeps a completed receipt with title, step count and clickable output refs', () => {
    mocks.tasks = [task({
      status: 'completed',
      progress: {
        current: 2,
        total: 2,
        lastToolStep: { tool: 'Write', target: '/repo/report.md', toolIndex: 1, toolTotal: 2, at: 3 },
      },
      outputRefs: [{
        id: 'output-1',
        taskId: 'task-1',
        type: 'file',
        label: '最终报告',
        path: '/repo/report.md',
        createdAt: 4,
      }],
    })];
    const view = renderCall();

    expect(view.getByText('· 已完成')).toBeTruthy();
    expect(view.getByText('核对发布清单')).toBeTruthy();
    expect(view.getByText('做了 2 步')).toBeTruthy();
    fireEvent.click(view.getByText('report.md'));
    expect(mocks.openPreview).toHaveBeenCalledWith('/repo/report.md');
  });

  it('shows one failure reason on the terminal receipt', () => {
    mocks.tasks = [task({
      status: 'failed',
      failure: { message: '远端服务超时' },
    })];
    const view = renderCall();

    expect(view.getByTestId('delegation-headline').textContent).toBe('核对发布清单 · 没有完成');
    expect(view.getByText('· 没有完成')).toBeTruthy();
    expect(view.getByTestId('delegation-failure').textContent).toBe('远端服务超时');
  });

  it('drops the activity and receipt when the matching task disappears instead of keeping stale data', () => {
    mocks.tasks = [task({
      progress: { lastToolStep: { tool: 'Read', target: '/repo/stale.md', at: 3 } },
    })];
    const view = renderCall();
    expect(view.getByTestId('delegation-activity')).toBeTruthy();

    mocks.tasks = [task({
      id: 'unrelated-task',
      toolCallId: 'different-call',
      title: '另一件任务',
      progress: { lastToolStep: { tool: 'Read', target: '/repo/other-stale.md', at: 4 } },
    })];
    view.rerender(<ToolCallDisplay toolCall={delegateCall()} index={0} total={1} />);

    expect(view.queryByTestId('delegation-activity')).toBeNull();
    expect(view.queryByTestId('delegation-receipt')).toBeNull();
    expect(view.queryByText(/stale\.md/)).toBeNull();
    expect(view.getByText('派出后台任务：核对发布清单')).toBeTruthy();
  });

  it('uses the agentTree node for background spawn activity and terminal state', () => {
    const spawnCall: ToolCall = {
      id: 'spawn-call-1',
      name: 'spawn_agent',
      arguments: { task: '审阅改动' },
      result: {
        toolCallId: 'spawn-call-1',
        success: true,
        output: 'Agent [reviewer] spawned in background:\n- Agent ID: agent-1\n- Status: running',
      },
    };
    const runningNode = {
      id: 'agent-1',
      role: '审阅代理',
      status: 'running' as const,
      statusLabel: '正在处理',
      task: '审阅改动',
      children: [],
      lastToolStep: { tool: 'agent_message', target: 'agent-2', at: 4 },
      worktreeState: { status: 'none' as const },
      budgetSummary: {},
      evidenceRefs: [],
      sources: ['spawnGuard' as const],
    };
    const peerNode = {
      ...runningNode,
      id: 'agent-2',
      role: '研究代理',
      task: '研究资料',
      lastToolStep: undefined,
    };
    mocks.snapshot = {
      generatedAt: 5,
      roots: [runningNode, peerNode],
      nodes: [runningNode, peerNode],
      summary: { total: 2, running: 2, completed: 0, failed: 0, cancelled: 0, blocked: 0, withWorktree: 0, ownershipConflicts: [] },
    };
    const view = renderCall(spawnCall);
    expect(view.getByTestId('delegation-activity').textContent).toBe('正在跟 研究代理 说话');

    const completedNode = {
      ...runningNode,
      status: 'completed' as const,
      statusLabel: '已完成',
      worktreeState: { status: 'preserved' as const, branch: 'agent/launch-polish', path: '/tmp/worktree/launch' },
    };
    mocks.snapshot = {
      ...mocks.snapshot,
      roots: [completedNode, peerNode],
      nodes: [completedNode, peerNode],
      summary: { ...mocks.snapshot.summary, running: 1, completed: 1 },
    };
    view.rerender(<ToolCallDisplay toolCall={spawnCall} index={0} total={1} />);
    const receipt = view.getByTestId('delegation-receipt');
    expect(view.getByText('· 已完成')).toBeTruthy();
    expect(receipt.querySelectorAll('[data-testid="delegation-branch"]')).toHaveLength(1);
    expect(view.getByTestId('delegation-branch').textContent).toBe('改动在分支 agent/launch-polish，合并后才会生效');
    expect(receipt.textContent).not.toContain('/tmp/worktree/launch');
  });

  it('keeps spawn_agent bookkeeping model-facing but hides it in expanded details with or without the tree node', () => {
    const spawnCall = completedSpawnCall();
    const completedNode = {
      id: 'agent_explore_7b8c452a-826d-4f84-a500-83beaa6c8015',
      role: 'explore',
      status: 'completed' as const,
      statusLabel: '已完成',
      task: '判断 2+2 等于多少。不要使用任何工具，只直接返回结论（一个数字）。',
      children: [],
      worktreeState: { status: 'none' as const },
      budgetSummary: {},
      evidenceRefs: [],
      sources: ['spawnGuard' as const],
    };
    mocks.snapshot = {
      generatedAt: 5,
      roots: [completedNode],
      nodes: [completedNode],
      summary: { total: 1, running: 0, completed: 1, failed: 0, cancelled: 0, blocked: 0, withWorktree: 0, ownershipConflicts: [] },
    };

    const found = renderCall(spawnCall);
    fireEvent.click(found.getByTestId('tool-call-row-spawn_agent'));
    const foundMore = found.queryByText(/展开剩余/);
    if (foundMore) fireEvent.click(foundMore);
    expect(found.container.textContent).not.toContain('Result:');
    expect(found.container.textContent).toContain('- Cost: $20/month');
    expect(found.container.textContent).toContain('- Agent ID: customer-visible-reference');
    expect(found.container.textContent).toContain('- Pipeline ID: customer-visible-plan');
    expect(found.container.textContent).not.toContain('- Agent ID: agent_explore_7b8c452a');
    expect(found.container.textContent).not.toContain('- Pipeline ID: agent_explore_7b8c452a');
    expect(found.container.textContent).not.toContain('- Cost: $0.0000');
    expect(spawnCall.result?.output).toBe(REAL_SPAWN_AGENT_OUTPUT);
    found.unmount();

    mocks.snapshot = null;
    const missing = renderCall(spawnCall);
    fireEvent.click(missing.getByTestId('tool-call-row-spawn_agent'));
    const missingMore = missing.queryByText(/展开剩余/);
    if (missingMore) fireEvent.click(missingMore);
    expect(missing.container.textContent).not.toContain('Result:');
    expect(missing.container.textContent).toContain('- Cost: $20/month');
    expect(missing.container.textContent).toContain('- Agent ID: customer-visible-reference');
    expect(missing.container.textContent).toContain('- Pipeline ID: customer-visible-plan');
    expect(missing.container.textContent).not.toContain('- Agent ID: agent_explore_7b8c452a');
    expect(missing.container.textContent).not.toContain('- Pipeline ID: agent_explore_7b8c452a');
    expect(missing.container.textContent).not.toContain('- Cost: $0.0000');
    expect(spawnCall.result?.output).toBe(REAL_SPAWN_AGENT_OUTPUT);
  });

  it('hides Task host cost in the fallthrough while preserving child result cost text', () => {
    const taskCallWithResult = completedTaskCall();
    const view = renderCall(taskCallWithResult);
    fireEvent.click(view.getByTestId('tool-call-row-Task'));
    const viewMore = view.queryByText(/展开剩余/);
    if (viewMore) fireEvent.click(viewMore);

    expect(view.container.textContent).toContain('- Cost: $20/month');
    expect(view.container.textContent).not.toContain('- Cost: $0.0169');
    expect(taskCallWithResult.result?.output).toBe(REAL_TASK_OUTPUT);
  });

  it('hides wait_agent host cost while preserving the child result cost text', () => {
    const waitCallWithResult = completedWaitAgentCall();
    const view = renderCall(waitCallWithResult);
    fireEvent.click(view.getByTestId('tool-call-row-wait_agent'));
    const viewMore = view.queryByText(/展开剩余/);
    if (viewMore) fireEvent.click(viewMore);

    expect(view.container.textContent).toContain('- Cost: $20/month');
    expect(view.container.textContent).not.toContain('$0.0169');
    expect(waitCallWithResult.result?.output).toBe(REAL_WAIT_AGENT_OUTPUT);
  });
});

// Integration guard: exercise the production component after main's report-only projection.
describe('delegation receipt — integrated display projection', () => {
  const backgroundOutput = `Agent [Explorer] spawned in background:
- Agent ID: agent_explore_background_receipt
- Task: 调研异步书面更新
- Status: running
- Mode: declarative
- Running agents: 1

Use wait_agent to block until done, or close_agent to cancel.`;

  it.each([
    ['background spawn', 'spawn_agent', backgroundOutput, '已派出', ['agent_explore_background_receipt', 'spawned in background:']],
    ['completed spawn', 'spawn_agent', REAL_SPAWN_AGENT_OUTPUT, '- Agent ID: customer-visible-reference', ['completed task:', '- Iterations: 1', '- Tools used: none']],
    ['completed Task', 'Task', REAL_TASK_OUTPUT, 'Notion: - Cost: $20/month; sync: database and page export.', ['completed (', '- Iterations: 2', '- Tools used: none']],
    ['wait result', 'wait_agent', `${REAL_WAIT_AGENT_OUTPUT}\n[agent_missing] NOT FOUND`, 'Notion and Obsidian comparison:', ['[agent_explore]', '[agent_missing]', 'NOT FOUND']],
  ] as const)('preserves the complete raw tool call when rendering %s', (_shape, name, output, expected, hidden) => {
    const call: ToolCall = {
      id: 'integration-raw-call',
      name,
      arguments: name === 'wait_agent'
        ? { agentIds: ['agent_explore', 'agent_missing'] }
        : { role: 'explore', task: '调研异步书面更新' },
      result: {
        toolCallId: 'integration-raw-call',
        success: true,
        output,
        metadata: { agentId: 'agent_explore_background_receipt' },
      },
    };
    const raw = structuredClone(call);
    const view = renderCall(call);
    fireEvent.click(view.getByTestId(`tool-call-row-${name}`));
    const more = view.queryByText(/展开剩余/);
    if (more) fireEvent.click(more);
    expect(view.container.textContent).toContain(expected);
    for (const text of hidden) expect(view.container.textContent).not.toContain(text);
    expect(call).toStrictEqual(raw);
  });
});

// ── N-APPROVAL-PENDING-STATUS-COPY：审批卡还挂着时，工作行不得谎报「发送了邮件」 ──

function pendingMailRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: 'perm-mail-1',
    type: 'network',
    tool: 'mail_send',
    agentId: 'task-1',
    details: {},
    timestamp: 1,
    ...overrides,
  };
}

function mailTask(overrides: Partial<Task> = {}): Task {
  return task({
    progress: { lastToolStep: { tool: 'mail_send', at: 3 } },
    ...overrides,
  });
}

describe('delegation receipt — approval pending copy', () => {
  it('unresolved pending request: row reads the pending form, never 发送了邮件', () => {
    mocks.tasks = [mailTask()];
    mocks.pendingPermissionRequest = pendingMailRequest();
    mocks.pendingPermissionSessionId = 'session-1';
    const view = renderCall();

    const row = view.getByTestId('delegation-activity').textContent ?? '';
    expect(row).toContain('请求发送邮件');
    expect(row).not.toContain('发送了邮件');
  });

  it('queued unresolved request for the session reads the same pending form', () => {
    mocks.tasks = [mailTask()];
    mocks.queuedPermissionRequests = { 'session-1': [pendingMailRequest({ id: 'perm-mail-2' })] };
    const view = renderCall();

    const row = view.getByTestId('delegation-activity').textContent ?? '';
    expect(row).toContain('请求发送邮件');
    expect(row).not.toContain('发送了邮件');
  });

  it('request resolved: row falls to the running form (deny answers the card)', () => {
    mocks.tasks = [mailTask()];
    mocks.pendingPermissionRequest = pendingMailRequest({ resolved: true });
    mocks.pendingPermissionSessionId = 'session-1';
    const view = renderCall();

    const row = view.getByTestId('delegation-activity').textContent ?? '';
    expect(row).toContain('正在发送邮件');
    expect(row).not.toContain('发送了邮件');
  });

  it('request absent: connector write keeps the running form while working', () => {
    mocks.tasks = [mailTask()];
    const view = renderCall();

    const row = view.getByTestId('delegation-activity').textContent ?? '';
    expect(row).toBe('邮件 · 正在发送邮件');
  });

  it('request naming another task does not hijack this row', () => {
    mocks.tasks = [mailTask()];
    mocks.pendingPermissionRequest = pendingMailRequest({ agentId: 'task-other' });
    mocks.pendingPermissionSessionId = 'session-1';
    const view = renderCall();

    expect(view.getByTestId('delegation-activity').textContent).toBe('邮件 · 正在发送邮件');
  });

  it('read tools keep today wording while working: a pending mail card does not flip them', () => {
    mocks.tasks = [task({
      progress: { lastToolStep: { tool: 'Read', target: '/repo/release.md', at: 3 } },
    })];
    mocks.pendingPermissionRequest = pendingMailRequest();
    mocks.pendingPermissionSessionId = 'session-1';
    const view = renderCall();

    expect(view.getByTestId('delegation-activity').textContent).toContain('读取了 /repo/release.md');
    expect(view.getByTestId('delegation-activity').textContent).not.toContain('正在读取');
  });

  it('read step awaiting its own approval reads the pending form', () => {
    mocks.tasks = [task({
      progress: { lastToolStep: { tool: 'Read', target: '/repo/release.md', at: 3 } },
    })];
    mocks.pendingPermissionRequest = pendingMailRequest({ tool: 'Read' });
    mocks.pendingPermissionSessionId = 'session-1';
    const view = renderCall();

    expect(view.getByTestId('delegation-activity').textContent).toContain('请求读取 /repo/release.md');
  });

  it('terminal task: receipt keeps the completed wording for the finished mail step', () => {
    mocks.tasks = [mailTask({ status: 'completed' })];
    const view = renderCall();

    expect(view.getByTestId('delegation-receipt')).toBeTruthy();
    expect(view.queryByTestId('delegation-activity')).toBeNull();
  });
});


describe('delegation receipt — cancelled retry and details', () => {
  const spawnCall: ToolCall = {
    id: 'spawn-compare',
    name: 'spawn_agent',
    arguments: { role: 'researcher', task: '对比三家供应商', run_in_background: true },
    result: { toolCallId: 'spawn-compare', success: true, metadata: { agentId: 'background-compare' } },
  };
  const node: AgentTreeNode = {
    id: 'execution-compare',
    backgroundAgentId: 'background-compare',
    role: 'researcher',
    displayName: '调研员',
    background: true,
    status: 'cancelled',
    statusLabel: '已取消',
    failureReason: '无法读取供应商报价',
    createdAt: 1,
    updatedAt: 4,
    completedAt: 3,
    children: [],
    worktreeState: { status: 'none' },
    budgetSummary: {},
    evidenceRefs: [],
    sources: ['backgroundRegistry'],
  };

  it.each([
    ['agent', spawnCall, [], [node], '调研员', '对比三家供应商', 'execution-compare', 3],
    ['task', delegateCall(), [task({ title: '发布协调', status: 'cancelled', summary: '无法读取清单' })], [],
      '发布协调', '核对发布清单', 'task-1', 2],
  ] as const)('shows both actions on a cancelled %s receipt', (_kind, call, tasks, nodes, title, dispatch, memberId, endedAt) => {
    const presentation = deriveDelegationPresentation(call, [...tasks], [...nodes]);
    expect(presentation).toMatchObject({ memberId, endedAt, retryTitle: dispatch });
    if (!presentation) throw new Error('Expected a delegation presentation');
    const view = render(<>
      <DelegationHeader presentation={presentation} />
      <DelegationReceipt presentation={presentation} superseded />
    </>);

    expect(view.getByTestId('delegation-headline').textContent).toBe(`${title} · 已取消`);
    expect(view.queryByTestId('delegation-failure')).toBeNull();
    expect(view.queryByTestId('delegation-failure-superseded')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: '查看详情' }));
    expect(mocks.setViewingMemberId).toHaveBeenCalledWith(memberId);
    fireEvent.click(view.getByRole('button', { name: '重试' }));
    expect(mocks.sendPrompt).toHaveBeenCalledWith(`请重新做一下我刚才取消的任务：${dispatch}`, {
      clientMessageId: expect.stringMatching(`^delegation-retry-${memberId}-`),
    });
  });

  it('keeps the failure headline, reason and retry wording for a failed agent', () => {
    const presentation = deriveDelegationPresentation(spawnCall, [], [{ ...node, status: 'failed' }]);
    if (!presentation) throw new Error('Expected a delegation presentation');
    const view = render(<>
      <DelegationHeader presentation={presentation} />
      <DelegationReceipt presentation={presentation} />
    </>);

    expect(view.getByTestId('delegation-headline').textContent).toBe('调研员 · 没有完成');
    expect(view.getByTestId('delegation-failure').textContent).toBe('无法读取供应商报价');
    fireEvent.click(view.getByRole('button', { name: '重试' }));
    expect(mocks.sendPrompt).toHaveBeenCalledWith('请重新做一下刚才失败的任务：对比三家供应商', {
      clientMessageId: expect.stringMatching(/^delegation-retry-execution-compare-/),
    });
  });
});


it.each([
  ['zh', '接下来我会直接操作「Keynote」的界面——这件事没有现成的连接器或网页路径可用。'],
  ['en', "Next I'll operate Keynote directly on screen — there's no connector or browser route for this."],
] as const)('shows the host disclosure once in the live and completed delegation receipt (%s)', (language, expected) => {
  mocks.language = language;
  try {
    const progress = { guiDisclosures: [{ app: 'Keynote', callId: 'keynote-call' }] };
    mocks.tasks = [task({ status: 'running', progress })];
    const view = renderCall();
    expect(view.getAllByTestId('gui-takeover-disclosure').map((row) => row.textContent)).toEqual([expected]);
    mocks.tasks = [task({ status: 'completed', progress })];
    view.rerender(<ToolCallDisplay toolCall={delegateCall()} index={0} total={1} />);
    expect(view.getAllByTestId('gui-takeover-disclosure').map((row) => row.textContent)).toEqual([expected]);
  } finally {
    mocks.language = 'zh';
    cleanup();
  }
});


it.each([
  ['zh', '未完成', '已完成', '删除没有成功，文件还在'],
  ['en', 'Incomplete', 'finished', 'The files are still there because the deletion did not succeed'],
] as const)('uses the %s incomplete title and reason in the delegation card', (language, incomplete, completed, reason) => {
  mocks.language = language;
  mocks.tasks = [task({
    status: 'failed',
    title: '已完成删除 / Deleted all files',
    failure: { reason: BACKGROUND_TASK_DELETE_INCOMPLETE, message: 'rm output' },
    leftoverPaths: ['/temporary/exports/export.csv'],
    progress: { current: 1 },
  })];
  const failed = renderCall();
  expect(failed.getByTestId('delegation-headline').textContent).toBe(`export.csv · ${incomplete}`);
  expect(failed.queryByTestId('delegation-retry')).toBeNull();
  expect(failed.getByTestId('delegation-failure').textContent).toBe(reason);
  expect((failed.container.textContent ?? '').replace(incomplete, '')).not.toMatch(/完成|completed|deleted all files|\/temporary/i);
  failed.unmount();
  mocks.tasks = [task({ status: 'completed' })];
  const success = renderCall();
  expect(success.getByTestId('delegation-headline').textContent?.toLowerCase()).toContain(completed.toLowerCase());
  cleanup();
  mocks.language = 'zh';
  mocks.tasks = [];
});
