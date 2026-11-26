// @vitest-environment jsdom
// ============================================================================
// N-WF-STALL-SPAWN-AGENT-REST2：子代理静默期间，输入框上方的「卡住了」让位给代理行徽标。
// DecisionSlot -> StallNoticeLine -> useAgentRowStallLevels 与 SessionAgentsPanel 一起渲染，
// 两处读同一个 hook，假时钟推进。
// ============================================================================
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { AgentTreeNode, AgentTreeSnapshot } from '../../../src/shared/contract/agentTree';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const stallListeners = vi.hoisted(() => new Set<(payload: unknown) => void>());
const invokeDomainMock = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  language: 'zh',
  setWorkbenchCollapsed: () => undefined,
  pendingPermissionRequest: null as { resolved?: boolean; agentId?: string } | null,
  pendingPermissionSessionId: null as string | null,
  queuedPermissionRequests: {} as Record<string, never>,
  activeWorkbenchTab: 'experts' as string | null,
  workbenchCollapsed: false,
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh, language: 'zh' }) }));
vi.mock('../../../src/renderer/stores/appStore', () => {
  const useAppStore = (selector?: (state: typeof appState) => unknown) => (selector ? selector(appState) : appState);
  useAppStore.getState = () => appState;
  return { useAppStore };
});
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke: vi.fn().mockResolvedValue([]), invokeDomain: invokeDomainMock },
  ipcService: {
    invoke: vi.fn().mockResolvedValue(undefined),
    on: (_channel: string, callback: (payload: unknown) => void) => {
      stallListeners.add(callback);
      return () => { stallListeners.delete(callback); };
    },
  },
}));

import { DecisionSlot } from '../../../src/renderer/components/features/chat/DecisionSlot';
import { SessionAgentsPanel } from '../../../src/renderer/components/TaskPanel/SessionAgentsPanel';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';

const emit = (payload: unknown) => act(() => { stallListeners.forEach((listener) => listener(payload)); });
const tick = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

function treeNode(overrides: Partial<AgentTreeNode>): AgentTreeNode {
  return {
    id: 'agent-9', role: '审阅代理', status: 'running', statusLabel: '正在处理',
    children: [], worktreeState: { status: 'none' }, budgetSummary: {}, evidenceRefs: [],
    sources: ['spawnGuard'], ...overrides,
  };
}

function mockTree(nodes: AgentTreeNode[]): void {
  const snapshot: AgentTreeSnapshot = {
    generatedAt: 1, roots: nodes, nodes,
    summary: {
      total: nodes.length, running: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0,
      withWorktree: 0, ownershipConflicts: [],
    },
  };
  invokeDomainMock.mockImplementation((domain: unknown, action: unknown) => (
    Promise.resolve(domain === IPC_DOMAINS.AGENT && action === 'getTree' ? snapshot : null)
  ));
}

const spawnNotice = (level: 'hint' | 'escalated' = 'hint') => (
  { sessionId: 'session-1', level, phase: 'tool', detail: 'spawn_agent' }
);

async function renderBoth(): Promise<void> {
  render(<><DecisionSlot /><SessionAgentsPanel /></>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

describe('DecisionSlot 与代理行「暂无进展」互让', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    stallListeners.clear();
    invokeDomainMock.mockReset();
    invokeDomainMock.mockResolvedValue(null);
    appState.pendingPermissionRequest = null;
    appState.pendingPermissionSessionId = null;
    appState.activeWorkbenchTab = 'experts';
    appState.workbenchCollapsed = false;
    useSwarmStore.setState({ activeSessionId: undefined, activeRunId: undefined, activeTreeId: undefined, lastEventAt: undefined, eventLog: [], agents: [] });
    useSessionStore.setState({ sessions: [], currentSessionId: 'session-1' });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('① spawn_agent 提示 + 行静默 121s / 601s：输入框提示不渲染，行徽标渲染', async () => {
    mockTree([treeNode({ updatedAt: Date.now() - 119_000 })]);
    await renderBoth();
    emit(spawnNotice());
    // 119s：行还没静默，输入框提示照常
    expect(screen.queryByTestId('agents-panel-quiet-agent-9')).toBeNull();
    expect(screen.queryByTestId('stall-notice')).not.toBeNull();

    await tick(5_000); // 124s
    expect(screen.getByTestId('agents-panel-quiet-agent-9')).toBeTruthy();
    expect(screen.queryByTestId('stall-notice')).toBeNull();

    await tick(480_000); // 604s
    expect(screen.getByTestId('agents-panel-long-agent-9')).toBeTruthy();
    expect(screen.queryByTestId('stall-notice')).toBeNull();
  });

  it('② 对照：别的工具、行未静默、没有行锚点，输入框提示照常渲染', async () => {
    mockTree([treeNode({ updatedAt: Date.now() - 130_000 })]);
    await renderBoth();
    expect(screen.getByTestId('agents-panel-quiet-agent-9')).toBeTruthy();
    emit({ sessionId: 'session-1', level: 'hint', phase: 'tool', detail: 'Read' });
    expect(screen.queryByTestId('stall-notice')).not.toBeNull();
    cleanup();

    mockTree([treeNode({ updatedAt: Date.now() - 119_000 })]);
    await renderBoth();
    emit(spawnNotice());
    expect(screen.queryByTestId('agents-panel-quiet-agent-9')).toBeNull();
    expect(screen.queryByTestId('stall-notice')).not.toBeNull();
    cleanup();

    mockTree([treeNode({})]); // 无任何锚点：fail-closed
    await renderBoth();
    emit(spawnNotice());
    expect(screen.queryByTestId('agents-panel-quiet-agent-9')).toBeNull();
    expect(screen.queryByTestId('stall-notice')).not.toBeNull();
  });

  it('⑦ 专家页签没打开（面板未挂载）：行已静默 121s，输入框提示仍然显示；右栏收起同理', async () => {
    mockTree([treeNode({ updatedAt: Date.now() - 121_000 })]);
    appState.activeWorkbenchTab = 'logs';
    render(<DecisionSlot />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    emit(spawnNotice());
    expect(screen.queryByTestId('agents-panel-quiet-agent-9')).toBeNull();
    expect(screen.queryByTestId('stall-notice')).not.toBeNull();
    cleanup();

    // 页签是 experts 但右栏收起：徽标同样看不到
    appState.activeWorkbenchTab = 'experts';
    appState.workbenchCollapsed = true;
    render(<DecisionSlot />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    emit(spawnNotice());
    expect(screen.queryByTestId('stall-notice')).not.toBeNull();
  });

  it('⑧ 还有别的行在推进：只有一行静默时输入框提示留着；全部静默才让位', async () => {
    mockTree([
      treeNode({ updatedAt: Date.now() - 130_000 }),
      treeNode({ id: 'agent-10', updatedAt: Date.now() - 10_000 }),
    ]);
    await renderBoth();
    emit(spawnNotice());
    expect(screen.getByTestId('agents-panel-quiet-agent-9')).toBeTruthy();
    expect(screen.queryByTestId('stall-notice')).not.toBeNull();
    cleanup();

    mockTree([
      treeNode({ updatedAt: Date.now() - 130_000 }),
      treeNode({ id: 'agent-10', updatedAt: Date.now() - 140_000 }),
    ]);
    await renderBoth();
    emit(spawnNotice());
    expect(screen.getByTestId('agents-panel-quiet-agent-10')).toBeTruthy();
    expect(screen.queryByTestId('stall-notice')).toBeNull();
  });

  it('③ 等审批的行不让位；放行后窗口重开，满 120s 行 quiet 了才让位', async () => {
    appState.pendingPermissionSessionId = 'session-1';
    appState.pendingPermissionRequest = {
      id: 'req-1', sessionId: 'session-1', tool: 'Write', type: 'file_write',
      details: { path: '/workspace/a.md' }, timestamp: 1, agentId: 'agent-9', resolved: false,
    } as never;
    mockTree([treeNode({ updatedAt: Date.now() - 130_000 })]);
    const view = render(<><DecisionSlot /><SessionAgentsPanel /></>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // 等审批：行不 quiet（hold 优先），也就没有让位依据
    expect(screen.queryByTestId('agents-panel-quiet-agent-9')).toBeNull();
    await tick(300_000);
    expect(screen.queryByTestId('agents-panel-quiet-agent-9')).toBeNull();

    // 放行：窗口重开，120s 内行不 quiet，输入框提示照常
    appState.pendingPermissionRequest = null;
    appState.pendingPermissionSessionId = null;
    view.rerender(<><DecisionSlot /><SessionAgentsPanel /></>);
    await tick(0);
    emit(spawnNotice());
    expect(screen.queryByTestId('agents-panel-quiet-agent-9')).toBeNull();
    expect(screen.queryByTestId('stall-notice')).not.toBeNull();

    await tick(125_000);
    expect(screen.getByTestId('agents-panel-quiet-agent-9')).toBeTruthy();
    expect(screen.queryByTestId('stall-notice')).toBeNull();
  });

  it('④ escalated 的 spawn_agent 提示在行 quiet/long 时同样让位；行恢复后提示重新露出', async () => {
    let nodes = [treeNode({ updatedAt: Date.now() - 130_000 })];
    mockTree(nodes);
    await renderBoth();
    emit(spawnNotice('escalated'));
    expect(screen.getByTestId('agents-panel-quiet-agent-9')).toBeTruthy();
    expect(screen.queryByTestId('stall-notice')).toBeNull();

    // 行上出现新进展 -> 行徽标清掉；通知仍在（host 没 clear），输入框提示露出，不留成「两处都没有」
    nodes = [treeNode({ updatedAt: Date.now() - 130_000, lastToolStep: { tool: 'Read', at: Date.now() } })];
    mockTree(nodes);
    await tick(3_000);
    await tick(5_000);
    expect(screen.queryByTestId('agents-panel-quiet-agent-9')).toBeNull();
    expect(screen.queryByTestId('stall-notice')).not.toBeNull();

    emit({ sessionId: 'session-1', clear: true });
    expect(screen.queryByTestId('stall-notice')).toBeNull();
  });
});
