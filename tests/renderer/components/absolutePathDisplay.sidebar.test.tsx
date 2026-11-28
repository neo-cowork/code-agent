// 侧栏项目抽屉：会话路径副标题与「工作区」路径列表不露 /Users/<账户>（zh / en）。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SidebarProjectDrawer } from '../../../src/renderer/components/features/sidebar/SidebarProjectDrawer';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function renderDrawer(): string {
  return renderToStaticMarkup(
    <SidebarProjectDrawer
      title="foo"
      summaryLine="foo"
      paths={['/Users/alice/work/foo', '/Users/alice/Documents/notes']}
      onClose={vi.fn()}
      onOpenSession={vi.fn()}
      onOpenWorkspaceAssets={vi.fn()}
      onNewSession={vi.fn()}
      onRenameProject={vi.fn()}
      onSetProjectDescription={vi.fn()}
      onSetProjectStatus={vi.fn()}
      onOpenArtifactSession={vi.fn()}
      onStartGoal={vi.fn()}
      onOpenGoalSession={vi.fn()}
      summary={{
        displayName: 'foo', sessionCount: 1, unfinishedCount: 0, needsInputCount: 0, pendingApprovalCount: 0,
        attentionCount: 0, runningCount: 0, reviewIssueCount: 0, artifactCount: 0, goalCount: 0, latestActivityAt: 1700000000000,
      } as never}
      meta={{ name: 'foo', status: 'active', goalCount: 0, goals: [], roleCount: 0, roleIds: [], artifactCount: 0, recentArtifacts: [], sessionCount: 1, updatedAt: 1 } as never}
      sessions={[{
        id: 'session-1',
        title: '整理周报',
        statusLabel: '空闲',
        statusToneClassName: 'text-zinc-400',
        showStatusBadge: false,
        typeLabel: '对话',
        lastActiveTitle: '2026/7/27 16:00:00',
        workingDirectory: '/Users/alice/work/foo',
        isCurrent: false,
        messageCount: 3,
        turnCount: 1,
        hasDeliverySignals: false,
        replayEvidenceCount: 0,
        pendingReviewCount: 0,
      } as never]}
    />,
  );
}

describe.each(['zh', 'en'] as const)('SidebarProjectDrawer 路径展示 (%s)', (language) => {
  it('会话副标题（无 summary 时回落到工作目录）与工作区列表显示 ~/ 短形式，不含 /Users/', () => {
    useAppStore.setState({ language });
    const html = renderDrawer();
    expect(html).not.toContain('/Users/');
    expect(html).toContain('~/work/foo');
    expect(html).toContain('~/Documents/notes');
  });
});
