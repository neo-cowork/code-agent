// @vitest-environment jsdom
// ============================================================================
// 快速对话层：层头之下不再有同名的合成「未分类」组头；二级页打开时会话行不高亮。
// 走生产组件 SidebarSessionList → SidebarProjectGroup → SidebarSessionItem + 真实 appStore。
// ============================================================================
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const lang = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: lang.value === 'zh' ? zh : en, language: lang.value }) };
});

vi.mock('../../../src/renderer/stores/sessionListPagination', () => ({
  useSessionListLoadStore: () => ({ settled: true, loading: false, error: false, errorCode: null }),
}));

import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { SidebarCapabilityZone } from '../../../src/renderer/components/features/sidebar/SidebarCapabilityZone';
import { SidebarSessionList } from '../../../src/renderer/components/features/sidebar/SidebarSessionList';

afterEach(() => {
  cleanup();
  useAppStore.setState({ showProjectSpacePage: false, showSettings: false });
});
beforeEach(() => { lang.value = 'zh'; });

const session = (id: string) => ({
  id, title: `Chat ${id}`, type: 'chat', status: 'idle', createdAt: 1, updatedAt: 2,
  messageCount: 2, turnCount: 1, modelConfig: { provider: 'openai', model: 'gpt-5' },
});

function renderList(groups: unknown[], currentSessionId: string | null = null) {
  const props = {
    groups, isLoading: false, hasAnySessions: true, filteredSessionsEmpty: false,
    messageSearchLoading: false, searchQuery: '', sessionStatusFilter: 'all',
    activeStatusFilterLabel: '', hasSearchFilters: false,
    projectMetaById: {}, setProjectMetaById: vi.fn(),
    expandedWorkspaces: {}, collapsingWorkspaces: {}, expandedProjectDetails: {},
    projectDrawerKey: null, isCreatingSession: false, creatingWorkspaceKey: null,
    setProjectDrawerKey: vi.fn(), setExpandedProjectDetails: vi.fn(),
    handleToggleWorkspaceGroup: vi.fn(), handleOpenWorkspaceAssets: vi.fn(),
    handleNewWorkspaceChat: vi.fn(), handleOpenProjectArtifactSession: vi.fn(),
    handleStartProjectGoal: vi.fn(), handleSelectSession: vi.fn(),
    handleRenameSidebarProject: vi.fn(), handleSetSidebarProjectStatus: vi.fn(),
    handleSetSidebarProjectDescription: vi.fn(), createWorkspaceChat: vi.fn(),
    openWorkspacePreview: vi.fn(), buildProjectDrawerSessions: () => [],
    sessionItemProps: {
      unreadSessionIds: new Set(), automationSummariesBySessionId: {}, currentSessionId,
      selectedSessionIds: new Set(), pinnedSessionIds: new Set(), renamingId: null,
      sessionRuntimes: new Map(), backgroundSessionMap: new Map(), sessionStates: {},
      hasNeedsInputForSession: () => false, searchQuery: '', messageSearchHitsBySessionId: {},
      replayEvidenceBySessionId: new Map(), reviewItemsBySessionId: {}, trajectoryQualityBySessionId: {},
      multiSelectMode: false, hoveredSession: null, renameValue: '',
      renameInputRef: { current: null }, setHoveredSession: vi.fn(), setRenameValue: vi.fn(),
      handleSelectSession: vi.fn(), handleContextMenu: vi.fn(), handleRenameSubmit: vi.fn(),
      handleRenameKeyDown: vi.fn(), handleDoubleClick: vi.fn(), handleOpenReplayEvidence: vi.fn(),
      handleSelectMessageSearchHit: vi.fn(), handleArchiveSession: vi.fn(),
    },
    cloudBadge: false, handleNewChat: vi.fn(), handleNewIndependentSpace: vi.fn(),
  } as unknown as React.ComponentProps<typeof SidebarSessionList>;
  return render(<SidebarSessionList {...props} />);
}

const uncategorized = (name: string) => ({
  key: 'uncategorized', name, path: undefined, paths: [], projectId: null, isUncategorized: true,
  sessions: [session('s1')], latestActivityAt: 2,
});
const folder = {
  key: 'folder:/tmp/notes', name: 'notes', path: '/tmp/notes', paths: ['/tmp/notes'], projectId: null,
  isUncategorized: false, sessions: [session('s2')], latestActivityAt: 2,
};

function countText(container: HTMLElement, text: string): number {
  return Array.from(container.querySelectorAll('*'))
    .filter((el) => el.children.length === 0 && el.textContent?.trim() === text).length;
}

describe('快速对话层标题唯一', () => {
  for (const [code, copy] of [['zh', zh], ['en', en]] as const) {
    it(`${code}: 层头之外没有第二个同名行，会话直挂层头下`, () => {
      lang.value = code;
      const title = copy.sidebarProject.tierQuick;
      const { container } = renderList([uncategorized(title)]);
      expect(countText(container, title)).toBe(1);
      expect(container.textContent).toContain('Chat s1');
    });
  }

  it('快速对话层里有真实文件夹名的分组仍保留组头', () => {
    const { container } = renderList([uncategorized(zh.sidebarProject.tierQuick), folder]);
    expect(countText(container, zh.sidebarProject.tierQuick)).toBe(1);
    expect(countText(container, 'notes')).toBe(1);
  });
});

describe('二级页打开时会话行不高亮', () => {
  const selected = (c: HTMLElement) => c.querySelectorAll('[aria-current="true"]').length;

  it('所有二级页开关关闭时当前会话行高亮', () => {
    const { container } = renderList([uncategorized('q')], 's1');
    expect(selected(container)).toBe(1);
  });

  it('Spaces 页打开：不高亮', () => {
    useAppStore.setState({ showProjectSpacePage: true });
    expect(selected(renderList([uncategorized('q')], 's1').container)).toBe(0);
  });

  it('设置页打开：不高亮', () => {
    useAppStore.setState({ showSettings: true });
    expect(selected(renderList([uncategorized('q')], 's1').container)).toBe(0);
  });
});

describe('浅色下唯一可见高亮（栏面色 --sidebar-bg 不能当高亮色）', () => {
  it('Spaces 页打开：协作空间入口带可见高亮类，不是与栏面同色的 bg-zinc-800', () => {
    useAppStore.setState({ showProjectSpacePage: true });
    const { getByTestId } = render(<SidebarCapabilityZone />);
    const row = getByTestId('sidebar-capability-projects');
    expect(row.getAttribute('aria-current')).toBe('page');
    expect(row.className).toContain('bg-zinc-700/60');
    expect(row.className).not.toMatch(/(?<![:\w-])bg-zinc-800(?!\/)/);
  });

  it('命名空间组头用栏面色而非 bg-zinc-950（浅色下是纯白条，读作选中）', () => {
    const { container } = renderList([folder]);
    const header = container.querySelector('[data-sidebar-group-phase]')?.firstElementChild;
    expect(header?.className).toContain('bg-[var(--sidebar-bg)]');
    expect(header?.className).not.toContain('bg-zinc-950');
  });
});
