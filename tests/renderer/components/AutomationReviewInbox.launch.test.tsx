// @vitest-environment jsdom
// N-FIX-CRON-SPAWN-LAUNCH-APPROVAL-NOT-IN-INBOX-CORE ④：收件箱里的团队启动审批行。
// 标题复用会话卡的问句（t.decisionCard.swarm.question，带成员数），按钮只有批准 / 拒绝，
// 点击经同一条权限应答 IPC 回传（id + 应答 + 会话 id）。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParkedApprovalInboxItem } from '../../../src/shared/contract/pendingApproval';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { AutomationReviewInbox } from '../../../src/renderer/components/features/cron/AutomationReviewInbox';

const state = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  rows: [] as ParkedApprovalInboxItem[],
  invoke: vi.fn(async () => ({ requestId: 'launch-1', decision: 'approved' })),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh, en } = await import('../../../src/renderer/i18n');
  return { useI18n: () => ({ t: state.language === 'zh' ? zh : en, language: state.language }) };
});
vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: {
    listPendingReview: async () => [],
    countPendingReview: async () => 0,
    listOutboundDrafts: async () => [],
    listParkedApprovals: async () => state.rows,
  },
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invoke: state.invoke } }));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (select: (s: { switchSession: () => void }) => unknown) => select({ switchSession: vi.fn() }),
}));
afterEach(() => { cleanup(); state.language = 'zh'; state.rows = []; state.invoke.mockClear(); });

function launchRow(memberCount: number): ParkedApprovalInboxItem {
  return {
    id: 'launch-1',
    kind: 'launch',
    sessionId: 'session-cron',
    sessionTitle: 'Weekly report',
    tool: 'spawn_agent',
    status: 'pending',
    requestedAt: Date.now() - 5 * 60_000,
    launchMemberCount: memberCount,
  };
}

describe('team-launch approval row in the review inbox', () => {
  it.each([
    ['zh', 1, '批准 1 个成员启动？', '等待 5 分钟', ['批准', '拒绝']],
    ['zh', 3, '批准 3 个成员启动？', '等待 5 分钟', ['批准', '拒绝']],
    ['en', 1, 'Approve starting 1 member?', 'Waiting 5 min', ['Approve', 'Reject']],
    ['en', 3, 'Approve starting 3 members?', 'Waiting 5 min', ['Approve', 'Reject']],
  ] as const)('%s, %i member(s): swarm question copy, task name, waiting time, exactly two buttons', async (language, count, question, waiting, buttonLabels) => {
    state.language = language;
    state.rows = [launchRow(count)];
    render(<AutomationReviewInbox />);

    const card = await waitFor(() => screen.getByTestId('parked-approval-item'));
    expect(card.textContent).toContain(question);
    expect(within(card).getByTestId('parked-session-title').textContent).toBe('Weekly report');
    expect(card.textContent).toContain(waiting);

    const buttons = within(card).getAllByRole('button');
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(buttonLabels);
    expect(buttons.map((button) => button.getAttribute('data-testid'))).toEqual(['parked-approve', 'parked-reject']);
    for (const absent of ['parked-allow-run', 'parked-allow-24h', 'parked-always-allow', 'parked-allow-folder']) {
      expect(within(card).queryByTestId(absent)).toBeNull();
    }
    // 不漏内部名：工具名、内部 id 都不该出现在卡片上。
    expect(card.textContent).not.toMatch(/spawn_agent|launch-1|session-cron/);
    if (language === 'en') expect(card.textContent).not.toMatch(/[㐀-鿿]/u);
  });

  it.each([
    ['parked-approve', 'allow'],
    ['parked-reject', 'deny'],
  ] as const)('%s posts %s for the launch id with its session id', async (testId, response) => {
    state.rows = [launchRow(1)];
    render(<AutomationReviewInbox />);
    const card = await waitFor(() => screen.getByTestId('parked-approval-item'));

    fireEvent.click(within(card).getByTestId(testId));

    await waitFor(() => expect(state.invoke).toHaveBeenCalledTimes(1));
    expect(state.invoke).toHaveBeenCalledWith(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'launch-1', response, 'session-cron');
  });

  it('a tool approval next to it keeps its own buttons (the launch branch does not leak)', async () => {
    state.rows = [
      launchRow(2),
      { id: 'tool-1', kind: 'tool_approval', sessionId: 'session-cron', tool: 'Bash', displayTool: 'Bash', status: 'pending', requestedAt: Date.now() },
    ];
    render(<AutomationReviewInbox />);
    const cards = await waitFor(() => {
      const found = screen.getAllByTestId('parked-approval-item');
      expect(found).toHaveLength(2);
      return found;
    });
    expect(within(cards[0]).queryByTestId('parked-allow-run')).toBeNull();
    expect(within(cards[1]).getByTestId('parked-allow-run')).toBeTruthy();
    expect(cards[1].textContent).not.toContain('成员启动');
  });
});
