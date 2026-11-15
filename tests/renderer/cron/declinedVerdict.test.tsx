// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CronExecutionList } from '../../../src/renderer/components/features/cron/CronExecutionList';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';
import { SidebarSessionItem, type SidebarSessionItemProps } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import type { CronJobExecution } from '../../../src/shared/contract/cron';

const execution: CronJobExecution = {
  id: 'download-run', jobId: 'nightly-sort', sessionId: 'download-session', status: 'completed',
  scheduledAt: 1, startedAt: 1, completedAt: 2, retryAttempt: 0,
  result: { sessionId: 'download-session', urgency: 'fyi', permissionDenied: {
    count: 1, steps: [{ tool: 'Bash', summary: 'Move Downloads into folders', reason: 'user' }],
  } },
};
function sidebarProps(sessionId = 'download-session'): SidebarSessionItemProps {
  return {
    session: {
      id: sessionId, title: '[定时] 夜间整理下载文件', type: 'schedule', status: 'idle',
      origin: { kind: 'cron', id: 'nightly-sort', name: '夜间整理下载文件' },
      createdAt: 1, updatedAt: 2, messageCount: 4, turnCount: 1,
      modelConfig: { provider: 'openai', model: 'test-model' },
    },
    unreadSessionIds: new Set(), automationSummariesBySessionId: {}, currentSessionId: null,
    selectedSessionIds: new Set(), pinnedSessionIds: new Set(), renamingId: null,
    sessionRuntimes: new Map(), backgroundSessionMap: new Map(), sessionStates: {},
    hasNeedsInputForSession: () => false,
    searchQuery: '', messageSearchHitsBySessionId: {}, replayEvidenceBySessionId: new Map(),
    reviewItemsBySessionId: {}, trajectoryQualityBySessionId: {}, multiSelectMode: false,
    hoveredSession: null, renameValue: '', renameInputRef: React.createRef<HTMLInputElement>(),
    setHoveredSession: vi.fn(), setRenameValue: vi.fn(), handleSelectSession: vi.fn(),
    handleContextMenu: vi.fn(), handleRenameSubmit: vi.fn(), handleRenameKeyDown: vi.fn(),
    handleDoubleClick: vi.fn(), handleOpenReplayEvidence: vi.fn(),
    handleSelectMessageSearchHit: vi.fn(), handleArchiveSession: vi.fn(),
  };
}
afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
  useCronStore.setState({ latestExecutions: {}, executionsByJobId: {}, recentExecutions: [] });
});

describe.each(['zh', 'en'] as const)('declined cron verdict (%s)', (language) => {
  it.each(['latest', 'recent', 'history'])('agrees on run list/detail/sidebar from %s records', (source) => {
    useAppStore.setState({ language });
    useCronStore.setState({
      latestExecutions: source === 'latest' ? { 'nightly-sort': execution } : {},
      recentExecutions: source === 'recent' ? [execution] : [],
      executionsByJobId: source === 'history' ? { 'nightly-sort': [execution] } : {},
    });
    const views = [
      render(<CronExecutionList executions={[execution]} selectedExecutionId={null} onSelectExecution={vi.fn()} />),
      render(<CronExecutionDetail execution={execution} />),
      render(<SidebarSessionItem {...sidebarProps()} />),
    ];
    const ids = ['cron-execution-permission-denied', 'cron-exec-detail-permission-denied', 'sidebar-cron-permission-denied'];
    const label = language === 'zh' ? '需处理' : 'Needs attention';
    for (const [index, view] of views.entries()) {
      const badge = within(view.container).getByTestId(ids[index]);
      expect(badge.textContent).toBe(label);
      expect(badge.className).toContain('text-badge-warning');
      expect(within(view.container).queryByText(language === 'zh' ? '完成' : 'Done', { exact: true })).toBeNull();
    }
  });
  it('does not apply the latest run marker to another session of the same job or a productive result', () => {
    useAppStore.setState({ language });
    useCronStore.setState({ latestExecutions: { 'nightly-sort': execution }, recentExecutions: [], executionsByJobId: {} });
    const view = render(<SidebarSessionItem {...sidebarProps('other-session')} />);
    expect(within(view.container).queryByTestId('sidebar-cron-permission-denied')).toBeNull();
    useCronStore.setState({ latestExecutions: { 'nightly-sort': { ...execution, result: { digest: { artifacts: ['sort-report.md'] } } } } });
    view.rerender(<SidebarSessionItem {...sidebarProps()} />);
    expect(within(view.container).queryByTestId('sidebar-cron-permission-denied')).toBeNull();
  });
});

describe.each(['zh', 'en'] as const)('declined cron detail urgency chip (%s)', (language) => {
  const digestResult = (urgency: 'fyi' | 'must_today', reason: 'user' | 'timeout') => ({
    agentType: 'agent', prompt: 'sort downloads', sessionId: 'download-session', urgency,
    digest: { summary: 'urgency: must_today\nNothing was moved; the step was declined.', artifacts: [] },
    permissionDenied: { count: 1, steps: [{ tool: 'Bash', summary: 'Move Downloads into folders', reason }] },
  });
  const chip = (result: unknown) => {
    useAppStore.setState({ language });
    const view = render(<CronExecutionDetail execution={{ ...execution, result }} />);
    return within(view.container).queryByTestId('cron-result-urgency')?.textContent ?? null;
  };
  it('shows the host-capped tier, not the must_today header in the digest, for a user-only denial', () => {
    expect(chip(digestResult('fyi', 'user'))).toBe(language === 'zh' ? '仅供参考' : 'FYI');
  });
  it('keeps the declared tier when the denial was a timeout', () => {
    expect(chip(digestResult('must_today', 'timeout'))).toBe(language === 'zh' ? '今日必办' : 'Must do today');
  });
});
