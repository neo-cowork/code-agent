// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTreeNode, AgentTreeNodeStatus, AgentTreeSnapshot } from '../../../src/shared/contract/agentTree';
import type { ToolCall } from '../../../src/shared/contract';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { useAgentTreeSnapshot } from '../../../src/renderer/hooks/useAgentTreeSnapshot';
import { useSessionAgentRows } from '../../../src/renderer/hooks/useSessionAgentRows';
import { deriveDelegationPresentation, toDelegationDisplayToolCall } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';
import { DelegationHeader, DelegationReceipt } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/DelegationReceipt';
import { SessionMemberBar } from '../../../src/renderer/components/features/expert/SessionMemberBar';
import { SessionAgentsPanel } from '../../../src/renderer/components/TaskPanel/SessionAgentsPanel';
import { StreamingIndicator } from '../../../src/renderer/components/features/chat/StreamingIndicator';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';

let language: 'zh' | 'en' = 'en';
const invoke = vi.fn();
const invokeDomain = vi.fn();
const app = {
  get language() { return language; },
  pendingPermissionRequest: null, pendingPermissionSessionId: null, queuedPermissionRequests: {},
  processingSessionIds: new Set<string>(),
  activeAgentId: null, setWorkbenchCollapsed: vi.fn(),
};
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: language === 'en' ? en : zh }) }));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign((selector: (state: typeof app) => unknown) => selector(app), { getState: () => app }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: {
  invoke: (...args: unknown[]) => invoke(...args),
  invokeDomain: (...args: unknown[]) => invokeDomain(...args),
} }));

const call: ToolCall = {
  id: 'weekly-report-call', name: 'spawn_agent', arguments: { task: 'Summarize three pages into a weekly report', run_in_background: true },
  result: { toolCallId: 'weekly-report-call', success: true, metadata: { agentId: 'weekly-assistant' },
    output: 'Agent [weekly-assistant] spawned in background: weekly report' },
};
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;

function node(status: AgentTreeNodeStatus, failureCode?: AgentFailureCode): AgentTreeNode {
  return { id: 'weekly-assistant', role: 'background', background: true, status, statusLabel: '旧状态',
    task: call.arguments.task as string, children: [], worktreeState: { status: 'none' }, budgetSummary: {}, evidenceRefs: [],
    sources: ['subagentContext'], failureCode, ...(failureCode ? { failureReason: '父任务已经结束' } : {}) };
}
function snapshot(child: AgentTreeNode): AgentTreeSnapshot {
  return { sessionId: 'weekly-session', generatedAt: 1, roots: [child], nodes: [child], summary: {
    total: 1, running: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, withWorktree: 0, ownershipConflicts: [],
  } };
}
function ChatCard() {
  const { snapshot: tree } = useAgentTreeSnapshot('weekly-session');
  const { rows } = useSessionAgentRows('weekly-session');
  const presentation = deriveDelegationPresentation(call, [], tree?.nodes ?? [], language === 'en' ? en : zh);
  return <div data-testid="snapshot-chat" data-node-status={rows[0]?.node?.status}>
    {presentation && <><DelegationHeader presentation={presentation} /><DelegationReceipt presentation={presentation} /></>}
  </div>;
}
const cases = [
  ['queued', 'Background assistant is working', '助手正在处理', 'Working', '工作中'],
  ['running', 'Background assistant is working', '助手正在处理', 'Working', '工作中'],
  ['running-recovered', 'Background assistant is working', '助手正在处理', 'Working', '工作中'],
  ['dead-log-only', 'Background assistant was interrupted', '助手已中断', 'Interrupted', '已中断'],
  ['completed', 'Background assistant finished', '助手已完成', 'Done', '完成'],
  ['failed', "Background assistant didn't finish", '助手没有完成', 'Failed', '失败'],
  ['cancelled', 'Background assistant was cancelled', '助手已取消', 'Cancelled', '已取消'],
  ['killed', 'Background assistant was stopped', '助手已中止', 'Aborted', '已中止'],
  ['blocked', 'Background assistant is waiting for you', '助手正在等你回应', 'Waiting for you', '等你回应'],
  ['unknown', 'Background assistant was interrupted', '助手已中断', 'Interrupted', '已中断'],
] as const;

beforeEach(() => {
  app.processingSessionIds = new Set(['weekly-session']);
  invoke.mockReset().mockResolvedValue([]);
  invokeDomain.mockReset().mockResolvedValue(null);
  useSessionStore.setState({ sessions: [], currentSessionId: 'weekly-session' });
  useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
  useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
  useAgentRegistryStore.setState({ entries: [], isLoaded: true });
  useBackgroundTaskStore.setState({ tasks: [] });
  useSwarmStore.setState({ agents: [], activeRunId: undefined, activeSessionId: undefined, eventLog: [] });
});
afterEach(cleanup);

describe.each(['en', 'zh'] as const)('one tree snapshot across three surfaces (%s)', (locale) => {
  it.each(cases)('%s has the same outcome through real hooks and components', async (status, enHeadline, zhHeadline, enWord, zhWord) => {
    language = locale;
    const tree = snapshot(node(status));
    invokeDomain.mockResolvedValue(tree);
    const t = locale === 'en' ? en : zh;
    const view = render(<><ChatCard /><SessionMemberBar sessionId="weekly-session" /><SessionAgentsPanel /><StreamingIndicator startTime={1} waitingReason="subagent" subagentCount={1} /></>);
    const headline = await screen.findByTestId('delegation-headline');
    const panel = await screen.findByTestId('agents-panel-status-weekly-assistant');
    const bar = screen.getByTestId('session-member-bar-collapsed');
    expect(screen.getByTestId('snapshot-chat').dataset.nodeStatus).toBe(status);
    expect(headline.textContent).toBe(locale === 'en' ? enHeadline : zhHeadline);
    expect(panel.textContent).toContain(locale === 'en' ? enWord : zhWord);
    const active = ['queued', 'running', 'running-recovered'].includes(status);
    expect(bar.textContent).toContain(locale === 'en' ? enWord : zhWord);
    const presentation = deriveDelegationPresentation(call, [], tree.nodes, t)!;
    const receipt = toDelegationDisplayToolCall(call, t, presentation);
    if (!active) expect(receipt.result?.output).not.toContain(t.chat.delegationReceipt.working);
    if (locale === 'en') {
      expect(view.container.textContent).not.toMatch(cjk);
      expect(view.container.textContent).not.toContain('Not completed background');
    }
    if (!active && status !== 'blocked') {
      expect(view.container.textContent).not.toMatch(/Agent working|代理工作中/);
      expect(view.container.querySelector('[aria-label="Agent working"]')).toBeNull();
    }
    process.stdout.write(`SURFACE_ASSERT ${locale} node=${status} chat=${JSON.stringify(headline.textContent)} bar=${JSON.stringify(bar.textContent)} panel=${JSON.stringify(panel.textContent)} cjk=${cjk.test(view.container.textContent ?? '')}\n`);
  });

  it('parent-gone is failed everywhere and the reason is on a separate line', async () => {
    language = locale;
    invokeDomain.mockResolvedValue(snapshot(node('failed', AgentFailureCode.ParentGone)));
    render(<><ChatCard /><SessionMemberBar sessionId="weekly-session" /><SessionAgentsPanel /><StreamingIndicator startTime={1} waitingReason="subagent" subagentCount={1} /></>);
    const headline = await screen.findByTestId('delegation-headline');
    const word = locale === 'en' ? 'Failed' : '失败';
    expect(headline.textContent).toBe(locale === 'en' ? "Background assistant didn't finish" : '助手没有完成');
    expect(screen.getByTestId('session-member-bar-collapsed').textContent).toContain(word);
    expect(screen.getByTestId('agents-panel-status-weekly-assistant').textContent).toContain(word);
    const reason = screen.getByTestId('delegation-failure');
    expect(reason.textContent).toBe(locale === 'en' ? 'The parent task has already ended' : '上级任务已经结束');
    expect(headline.contains(reason)).toBe(false);
  });

  it('counts both tree-backed and member-only agents with the same visible outcome', async () => {
    language = locale;
    invoke.mockImplementation((channel: string) => Promise.resolve(channel === 'swarm:list-trace-runs'
      ? [{ id: 'ledger', sessionId: 'weekly-session' }]
      : channel === 'swarm:get-trace-run-detail' ? {
        run: { id: 'ledger', sessionId: 'weekly-session', startedAt: 1, endedAt: null, totalTokensIn: 0, totalTokensOut: 0 },
        agents: ['weekly-assistant', 'report-editor'].map((agentId) => ({ agentId, name: 'Report assistant', role: 'background', status: 'running', tokensIn: 0, tokensOut: 0, filesChanged: [] })), events: [],
      } : []));
    invokeDomain.mockResolvedValue(snapshot(node('running')));
    render(<SessionMemberBar sessionId="weekly-session" />);
    await waitFor(() => expect(screen.getByTestId('session-member-bar-collapsed').textContent)
      .toContain(locale === 'en' ? '2 agents · Working' : '2 个代理 · 工作中'));
  });

  it('a recovered context node overrides a stale running member ledger', async () => {
    language = locale;
    invoke.mockImplementation((channel: string) => Promise.resolve(channel === 'swarm:list-trace-runs'
      ? [{ id: 'ledger', sessionId: 'weekly-session' }]
      : channel === 'swarm:get-trace-run-detail' ? {
        run: { id: 'ledger', sessionId: 'weekly-session', startedAt: 1, endedAt: 2, totalTokensIn: 0, totalTokensOut: 0 },
        agents: [{ agentId: 'weekly-assistant', name: 'Weekly report assistant', role: 'background', status: 'running', tokensIn: 0, tokensOut: 0, filesChanged: [] }], events: [],
      } : []));
    invokeDomain.mockResolvedValue(snapshot(node('cancelled', AgentFailureCode.CancelledByParent)));
    render(<><ChatCard /><SessionMemberBar sessionId="weekly-session" /><SessionAgentsPanel /><StreamingIndicator startTime={1} waitingReason="subagent" subagentCount={1} /></>);
    await screen.findByTestId('delegation-headline');
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('swarm:get-trace-run-detail', expect.anything()));
    const word = locale === 'en' ? 'Cancelled' : '已取消';
    expect(screen.getByTestId('agents-panel-status-weekly-assistant').textContent).toBe(word);
    expect(screen.getByTestId('session-member-bar-collapsed').textContent).toContain(word);
  });
});

it('the real turn indicator stays quiet for a restored trace without a live source', () => {
  language = 'en';
  app.processingSessionIds = new Set();
  const view = render(<StreamingIndicator startTime={1} waitingReason="subagent" subagentCount={1} />);
  expect(view.container.textContent).not.toContain('Agent working');
  expect(view.container.textContent).not.toContain('agents working');
  expect(view.container.innerHTML).toBe('');
});

it('the real indicator names an assistant only while a live turn and live tree node agree', async () => {
  language = 'en';
  invokeDomain.mockResolvedValue(snapshot(node('running')));
  render(<StreamingIndicator startTime={1} waitingReason="subagent" subagentCount={1} />);
  await screen.findByLabelText('Agent working');
});
