// @vitest-environment jsdom
// ============================================================================
// 点击「选择文件夹」入口 → handleNewIndependentSpace → pickWorkingDirectory →
// createWorkspaceChat → createSession(workingDirectory = 选中目录)。
// SidebarSessionList 用真组件、useSidebarSessionActions 用真 hook，只 mock 选择器与 store 取数。
// ============================================================================
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

const listLoadState = { settled: true, loading: false, error: false, errorCode: null };
vi.mock('../../../src/renderer/stores/sessionListPagination', () => ({
  useSessionListLoadStore: () => listLoadState,
}));

const sessionUiState = { collapsedTiers: {} as Record<string, boolean>, setTierCollapsed: vi.fn() };
vi.mock('../../../src/renderer/stores/sessionUIStore', () => ({
  useSessionUIStore: (selector?: (state: typeof sessionUiState) => unknown) =>
    selector ? selector(sessionUiState) : sessionUiState,
}));

const appState = { openProjectSpacePage: vi.fn() };
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) =>
    selector ? selector(appState) : appState,
}));

vi.mock('../../../src/renderer/components/features/sidebar/SidebarProjectGroup', () => ({
  SidebarProjectGroup: () => null,
}));

const pickWorkingDirectory = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/workingDirectoryPicker', () => ({ pickWorkingDirectory }));

import { zh } from '../../../src/renderer/i18n/zh';
import { SidebarSessionList } from '../../../src/renderer/components/features/sidebar/SidebarSessionList';
import { useSidebarSessionActions } from '../../../src/renderer/components/features/sidebar/useSidebarSessionActions';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FOLDER = '/Users/someone/projects/weekly-report-helper';

function mountList(options: { groups: unknown[]; hasAnySessions: boolean }) {
  const createSession = vi.fn(async () => ({ id: 'new-session' }));
  const setWorkingDirectory = vi.fn();
  const params = {
    collapseTimersRef: { current: {} },
    setCollapsingWorkspaces: vi.fn(),
    setWorkspaceExpanded: vi.fn(),
    isCreatingSession: false,
    creatingWorkspaceKey: null,
    setCreatingSessionMode: vi.fn(),
    setCreatingWorkspaceKey: vi.fn(),
    createSession,
    clearPlanningState: vi.fn(),
    setWorkingDirectory,
    multiSelectMode: false,
    toggleSelection: vi.fn(),
    searchQuery: '',
    messageSearchHitsBySessionId: {},
    setPendingSearchJump: vi.fn(),
    currentSessionId: null,
    switchSession: vi.fn(async () => undefined),
    unarchiveSession: vi.fn(async () => undefined),
    archiveSession: vi.fn(async () => undefined),
    openWorkspacePreview: vi.fn(),
    setProjectMetaById: vi.fn(),
    t: zh,
  } as unknown as Parameters<typeof useSidebarSessionActions>[0];

  const Harness: React.FC = () => {
    const actions = useSidebarSessionActions(params);
    const props = {
      groups: options.groups,
      isLoading: false,
      hasAnySessions: options.hasAnySessions,
      filteredSessionsEmpty: false,
      messageSearchLoading: false,
      messageSearchFailed: false,
      searchQuery: '',
      sessionStatusFilter: 'all',
      activeStatusFilterLabel: '',
      hasSearchFilters: false,
      projectMetaById: {},
      setProjectMetaById: vi.fn(),
      expandedWorkspaces: {},
      collapsingWorkspaces: {},
      expandedProjectDetails: {},
      projectDrawerKey: null,
      isCreatingSession: false,
      creatingWorkspaceKey: null,
      setProjectDrawerKey: vi.fn(),
      setExpandedProjectDetails: vi.fn(),
      handleToggleWorkspaceGroup: vi.fn(),
      handleOpenWorkspaceAssets: vi.fn(),
      handleNewWorkspaceChat: vi.fn(),
      handleOpenProjectArtifactSession: vi.fn(),
      handleStartProjectGoal: vi.fn(),
      handleSelectSession: vi.fn(),
      handleRenameSidebarProject: vi.fn(),
      handleSetSidebarProjectStatus: vi.fn(),
      handleSetSidebarProjectDescription: vi.fn(),
      createWorkspaceChat: actions.createWorkspaceChat,
      openWorkspacePreview: vi.fn(),
      sessionItemProps: {},
      cloudBadge: false,
      handleNewChat: vi.fn(),
      handleNewIndependentSpace: actions.handleNewIndependentSpace,
    } as unknown as React.ComponentProps<typeof SidebarSessionList>;
    return React.createElement(SidebarSessionList, props);
  };
  return { view: render(React.createElement(Harness)), createSession, setWorkingDirectory };
}

describe('choose-folder entry click path', () => {
  it('zero-session state: click → picker → new task bound to the chosen folder', async () => {
    pickWorkingDirectory.mockResolvedValue(FOLDER);
    const { view, createSession, setWorkingDirectory } = mountList({ groups: [], hasAnySessions: false });

    fireEvent.click(view.getByTestId('sidebar-choose-folder-entry'));

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(pickWorkingDirectory).toHaveBeenCalledWith(zh.sidebar.selectDirectoryTitle);
    expect(createSession).toHaveBeenCalledWith(zh.sidebar.newSessionTitle, { workingDirectory: FOLDER });
    expect(setWorkingDirectory).toHaveBeenCalledWith(FOLDER);
  });

  it('zero-project-group state (only quick chats): same path, same binding', async () => {
    pickWorkingDirectory.mockResolvedValue(FOLDER);
    const quickGroup = { key: 'g-quick', projectId: null, sessions: [{ id: 's1' }] };
    const { view, createSession } = mountList({ groups: [quickGroup], hasAnySessions: true });

    fireEvent.click(view.getByTestId('sidebar-choose-folder-entry'));

    await waitFor(() => expect(createSession).toHaveBeenCalledWith(zh.sidebar.newSessionTitle, { workingDirectory: FOLDER }));
  });

  it('cancelled picker creates no session', async () => {
    pickWorkingDirectory.mockResolvedValue(null);
    const { view, createSession } = mountList({ groups: [], hasAnySessions: false });

    fireEvent.click(view.getByTestId('sidebar-choose-folder-entry'));

    await waitFor(() => expect(pickWorkingDirectory).toHaveBeenCalledTimes(1));
    expect(createSession).not.toHaveBeenCalled();
  });
});
