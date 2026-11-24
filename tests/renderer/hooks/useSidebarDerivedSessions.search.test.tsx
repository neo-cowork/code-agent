// @vitest-environment jsdom
import React from 'react';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { ProjectWithActivity } from '../../../src/shared/contract/project';
import { zh } from '../../../src/renderer/i18n/zh';

const state = vi.hoisted(() => ({
  session: {
    sessions: [] as any[],
    currentSessionId: 'message-hit',
    sessionRuntimes: new Map<string, unknown>(),
    backgroundSessions: [] as any[],
    pendingUserQuestionsBySessionId: new Map<string, unknown>(),
  },
  ui: {
    searchQuery: 'needle',
    sessionStatusFilter: 'all' as const,
    trajectoryTierFilter: 'all' as const,
    trajectoryFailureFilter: 'all' as const,
    trajectoryReviewFilter: 'all' as const,
  },
  app: {
    pendingPermissionRequest: null as unknown,
    pendingPermissionSessionId: null as string | null,
    queuedPermissionRequests: [] as unknown[],
  },
  backgroundTask: { tasks: [] as unknown[] },
  workflow: { runs: [] as unknown[] },
  task: { sessionStates: {} as Record<string, { status: string }> },
}));

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const projectClient = vi.hoisted(() => ({
  listProjectsWithActivity: vi.fn<() => Promise<ProjectWithActivity[]>>(),
  getProjectDetail: vi.fn(async (projectId: string) => ({
    project: { id: projectId, name: 'Project', status: 'active', description: '', updatedAt: 1 },
    goals: [],
    roles: [],
    sessionIds: ['message-hit', 'metadata-hit', 'archived-hit'],
  })),
  getProjectArtifacts: vi.fn(async () => []),
}));

vi.mock('../../../src/renderer/stores/sessionStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/renderer/stores/sessionStore')>(),
  useSessionStore: (selector: (store: unknown) => unknown) => selector(state.session),
}));
vi.mock('../../../src/renderer/stores/sessionUIStore', () => ({
  useSessionUIStore: (selector: (store: unknown) => unknown) => selector(state.ui),
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (store: unknown) => unknown) => selector(state.app),
}));
vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (store: unknown) => unknown) => selector(state.backgroundTask),
}));
vi.mock('../../../src/renderer/stores/workflowStore', () => ({
  useWorkflowStore: (selector: (store: unknown) => unknown) => selector(state.workflow),
}));
vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector: (store: unknown) => unknown) => selector(state.task),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: ipc,
}));
vi.mock('../../../src/renderer/services/projectClient', () => projectClient);
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { useSidebarDerivedSessions } from '../../../src/renderer/components/features/sidebar/useSidebarDerivedSessions';
import {
  composerDraftStorageKey,
  removeComposerDraft,
  writeComposerDraftIfAbsent,
} from '../../../src/renderer/components/features/chat/ChatInput/composerDraftStore';
import { SidebarSearchDialog } from '../../../src/renderer/components/features/sidebar/SidebarSearchDialog';

beforeEach(() => {
  vi.clearAllMocks();
  projectClient.listProjectsWithActivity.mockResolvedValue([]);
  localStorage.clear();
  state.ui.searchQuery = 'needle';
  state.session.currentSessionId = 'message-hit';
  state.session.sessionRuntimes = new Map();
  state.task.sessionStates = {};
  state.session.sessions = [
    {
      id: 'message-hit',
      title: 'Unrelated title',
      projectId: 'project-1',
      workingDirectory: '/repo',
      status: 'active',
      messageCount: 2,
      turnCount: 1,
      createdAt: 100,
      updatedAt: 300,
    },
    {
      id: 'metadata-hit',
      title: 'Needle metadata',
      projectId: 'project-1',
      workingDirectory: '/repo',
      status: 'active',
      messageCount: 1,
      turnCount: 1,
      createdAt: 90,
      updatedAt: 200,
    },
    {
      id: 'archived-hit',
      title: 'Needle archived session',
      projectId: 'project-1',
      workingDirectory: '/repo',
      status: 'archived',
      messageCount: 5,
      turnCount: 3,
      createdAt: 80,
      updatedAt: 400,
    },
  ];
  ipc.invoke.mockImplementation(async (channel: string) => {
    if (channel === IPC_CHANNELS.SESSION_SEARCH) {
      return {
        query: 'needle',
        totalMatches: 2,
        sessionsWithMatches: 2,
        searchTime: 1,
        truncated: false,
        results: [
          {
            sessionId: 'message-hit',
            sessionTitle: 'Unrelated title',
            messageId: 'message-1',
            messageIndex: 0,
            turnNumber: 1,
            role: 'user',
            timestamp: 290,
            matchOffset: 4,
            relevance: 0.9,
            snippet: 'body **needle** match',
            matchCount: 1,
          },
          {
            sessionId: 'archived-hit',
            sessionTitle: 'Needle archived session',
            messageId: 'message-archived',
            messageIndex: 0,
            role: 'assistant',
            timestamp: 390,
            relevance: 0.8,
            snippet: 'archived **needle**',
            matchCount: 1,
          },
        ],
      };
    }
    return {};
  });
});

describe('useSidebarDerivedSessions search results', () => {
  it('excludes archived sessions and keeps sessions found only through message content', async () => {
    const SearchHarness = () => {
      const derived = useSidebarDerivedSessions({ canOpenSessionReplay: false });
      return (
        <SidebarSearchDialog
          isOpen
          query={state.ui.searchQuery}
          onQueryChange={vi.fn()}
          onClose={vi.fn()}
          sessions={derived.searchResultSessions}
          currentSessionId={state.session.currentSessionId}
          messageSearchHitsBySessionId={derived.messageSearchHitsBySessionId}
          messageSearchLoading={derived.messageSearchLoading}
          messageSearchFailed={derived.messageSearchFailed}
          effectiveSearchScope={derived.effectiveSearchScope}
          setSearchScope={derived.setSearchScope}
          canSearchCurrentProject
          onSelectSession={vi.fn()}
        />
      );
    };
    render(<SearchHarness />);

    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_SEARCH, {
        query: 'needle',
        options: { limit: 80 },
      });
    });
    await waitFor(() => {
      expect(screen.queryByText('Unrelated title')).not.toBeNull();
    });

    expect(screen.queryByText('Needle metadata')).not.toBeNull();
    expect(screen.queryByText('Needle archived session')).toBeNull();
    expect(screen.queryByText('命中 1 条消息')).not.toBeNull();
  });

  it('orders same-title results newest first and keeps input order for equal update times', async () => {
    state.ui.searchQuery = '停车A';
    state.session.sessions = [
      {
        id: 'same-title-first',
        title: '[Schedule] 停车A-无目录',
        projectId: 'project-1',
        workingDirectory: '/repo',
        status: 'active',
        messageCount: 1,
        turnCount: 1,
        createdAt: 100,
        updatedAt: 500,
      },
      {
        id: 'same-title-second',
        title: '[Schedule] 停车A-无目录',
        projectId: 'project-1',
        workingDirectory: '/repo',
        status: 'active',
        messageCount: 1,
        turnCount: 1,
        createdAt: 90,
        updatedAt: 500,
      },
      {
        id: 'same-title-newest',
        title: '[Schedule] 停车A-无目录',
        projectId: 'project-1',
        workingDirectory: '/repo',
        status: 'active',
        messageCount: 1,
        turnCount: 1,
        createdAt: 80,
        updatedAt: 700,
      },
    ];
    const SearchOrderHarness = () => {
      const derived = useSidebarDerivedSessions({ canOpenSessionReplay: false });
      return <output data-testid="search-order">{derived.searchResultSessions.map((session) => session.id).join(',')}</output>;
    };

    render(<SearchOrderHarness />);
    await waitFor(() => {
      expect(screen.getByTestId('search-order').textContent).toBe(
        'same-title-newest,same-title-first,same-title-second',
      );
    });
  });
  const searchResponse = (extra: Record<string, unknown>) => ({
    query: 'needle',
    totalMatches: 0,
    sessionsWithMatches: 0,
    searchTime: 1,
    truncated: false,
    results: [],
    ...extra,
  });

  const renderDialog = () => {
    state.ui.searchQuery = 'needle';
    const Harness = () => {
      const derived = useSidebarDerivedSessions({ canOpenSessionReplay: false });
      return (
        <SidebarSearchDialog
          isOpen
          query={state.ui.searchQuery}
          onQueryChange={vi.fn()}
          onClose={vi.fn()}
          sessions={derived.searchResultSessions}
          currentSessionId={state.session.currentSessionId}
          messageSearchHitsBySessionId={derived.messageSearchHitsBySessionId}
          messageSearchLoading={derived.messageSearchLoading}
          messageSearchFailed={derived.messageSearchFailed}
          effectiveSearchScope={derived.effectiveSearchScope}
          setSearchScope={derived.setSearchScope}
          canSearchCurrentProject
          onSelectSession={vi.fn()}
        />
      );
    };
    return render(<Harness />);
  };

  it('lists hits from sessions outside the loaded page using host metadata, skipping archived ones', async () => {
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel !== IPC_CHANNELS.SESSION_SEARCH) return {};
      return searchResponse({
        results: [
          {
            sessionId: 'old-session',
            sessionTitle: '很久以前的浏览器任务',
            sessionUpdatedAt: 5,
            sessionArchived: false,
            messageId: 'm-old',
            role: 'user',
            timestamp: 5,
            relevance: 0.7,
            snippet: 'old **needle**',
            matchCount: 1,
          },
          {
            sessionId: 'old-archived',
            sessionTitle: 'Archived old needle',
            sessionUpdatedAt: 4,
            sessionArchived: true,
            messageId: 'm-arch',
            role: 'user',
            timestamp: 4,
            relevance: 0.7,
            snippet: 'x **needle**',
            matchCount: 1,
          },
        ],
        titleMatches: [{ sessionId: 'old-title-only', title: 'Old needle title only', updatedAt: 3 }],
      });
    });
    renderDialog();
    await waitFor(() => {
      expect(screen.queryByText('很久以前的浏览器任务')).not.toBeNull();
    });
    expect(screen.queryByText('Old needle title only')).not.toBeNull();
    expect(screen.queryByText('Archived old needle')).toBeNull();
    const calls = ipc.invoke.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.SESSION_SEARCH);
    expect(calls[0][1].options).not.toHaveProperty('sessionIds');
  });

  it('sends a projectScope (no sessionIds) in current-project scope and lists host hits outside the loaded window', async () => {
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel !== IPC_CHANNELS.SESSION_SEARCH) return {};
      return searchResponse({
        results: [{
          sessionId: 'old-session', sessionTitle: 'Remote old', sessionUpdatedAt: 5, sessionArchived: false,
          messageId: 'm', role: 'user', timestamp: 5, relevance: 0.7, snippet: 'a **needle**', matchCount: 1,
        }],
      });
    });
    state.ui.searchQuery = 'needle';
    const Harness = () => {
      const derived = useSidebarDerivedSessions({ canOpenSessionReplay: false });
      React.useEffect(() => { derived.setSearchScope('current-project'); }, []);
      return <output data-testid="ids">{derived.searchResultSessions.map((session) => session.id).join(',')}</output>;
    };
    render(<Harness />);
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_SEARCH, {
        query: 'needle',
        options: { limit: 80, projectScope: { projectId: 'project-1' } },
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('ids').textContent).toContain('old-session');
    });
    const scoped = ipc.invoke.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.SESSION_SEARCH);
    expect(scoped[scoped.length - 1][1].options).not.toHaveProperty('sessionIds');
  });

  it('shows the failed copy instead of the no-signal copy when the search request rejects', async () => {
    state.session.sessions = [];
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.SESSION_SEARCH) throw new Error('boom');
      return {};
    });
    renderDialog();
    await waitFor(() => {
      expect(screen.queryByText(zh.sidebar.searchFailed)).not.toBeNull();
    });
    expect(screen.queryByText(zh.sidebar.noMatchedSessions)).toBeNull();
  });

  it('treats an empty response (web transport swallows failures into undefined) as a failed search', async () => {
    state.session.sessions = [];
    ipc.invoke.mockImplementation(async () => undefined);
    renderDialog();
    await waitFor(() => {
      expect(screen.queryByText(zh.sidebar.searchFailed)).not.toBeNull();
    });
    expect(screen.queryByText(zh.sidebar.noMatchedSessions)).toBeNull();
  });

  it('still shows the no-signal copy when nothing matches anywhere', async () => {
    state.session.sessions = [];
    ipc.invoke.mockImplementation(async () => searchResponse({ titleMatches: [] }));
    renderDialog();
    await waitFor(() => {
      expect(screen.queryByText(zh.sidebar.noMatchedSessions)).not.toBeNull();
    });
    expect(screen.queryByText(zh.sidebar.searchFailed)).toBeNull();
  });
});

describe('useSidebarDerivedSessions blank rows', () => {
  const blank = {
    id: 'blank',
    title: '新对话',
    status: 'active',
    messageCount: 0,
    turnCount: 0,
    createdAt: 10,
    updatedAt: 10,
  };

  beforeEach(() => {
    state.ui.searchQuery = '';
    state.session.currentSessionId = blank.id;
    state.session.sessions.push(blank);
  });

  const renderSidebar = () => renderHook(() => useSidebarDerivedSessions({ canOpenSessionReplay: false }));

  it('keeps the selected blank row hidden from the list and workspace groups', () => {
    state.session.sessions = [blank];
    const { result } = renderSidebar();

    expect(result.current.filteredSessions.map((session) => session.id)).not.toContain(blank.id);
    expect(result.current.workspaceGroupedSessions.flatMap((group) => group.sessions.map((session) => session.id)))
      .not.toContain(blank.id);
    expect(result.current.hasAnySessions).toBe(false);
  });

  it('shows the blank row when a draft is persisted and hides it when removed', () => {
    const { result } = renderSidebar();
    const key = composerDraftStorageKey(blank.id, false);

    act(() => { writeComposerDraftIfAbsent(key, 'Summarize the release notes'); });
    expect(result.current.filteredSessions.map((session) => session.id)).toContain(blank.id);

    act(() => { removeComposerDraft(key); });
    expect(result.current.filteredSessions.map((session) => session.id)).not.toContain(blank.id);
  });

  it('refreshes draft visibility when another window changes the persisted draft', () => {
    const { result } = renderSidebar();
    const key = composerDraftStorageKey(blank.id, false);
    if (!key) throw new Error('Expected a session draft key');
    const draft = JSON.stringify({ v: 1, text: 'Draft from another window' });

    act(() => {
      localStorage.setItem(key, draft);
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: draft, storageArea: localStorage }));
    });
    expect(result.current.filteredSessions.map((session) => session.id)).toContain(blank.id);

    act(() => {
      localStorage.removeItem(key);
      window.dispatchEvent(new StorageEvent('storage', { key, oldValue: draft, storageArea: localStorage }));
    });
    expect(result.current.filteredSessions.map((session) => session.id)).not.toContain(blank.id);
  });

  it('keeps the collaboration space visible when its only loaded session is hidden', async () => {
    const space: ProjectWithActivity = {
      id: 'blank-space',
      name: 'Blank space',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      spacePromotedAt: 1,
      visibleSessionCount: 1,
      activeTopicCount: 0,
      lastActivityAt: null,
    };
    projectClient.listProjectsWithActivity.mockResolvedValue([
      space,
      { ...space, id: 'unloaded-space', name: 'Unloaded space' },
    ]);
    state.session.sessions = [{ ...blank, projectId: space.id }];

    const { result } = renderSidebar();

    await waitFor(() => {
      expect(result.current.workspaceGroupedSessions.map((group) => group.projectId)).toEqual([space.id]);
    });
    expect(result.current.workspaceGroupedSessions[0]?.sessions).toEqual([]);
    expect(result.current.visibleSessionIds).toEqual([]);
  });

  it('only synthesizes an empty collaboration group when hidden rows cover its full catalog count', async () => {
    const fullyLoadedSpace: ProjectWithActivity = {
      id: 'fully-loaded',
      name: 'Fully loaded space',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      spacePromotedAt: 1,
      visibleSessionCount: 2,
      activeTopicCount: 0,
      lastActivityAt: null,
    };
    const pagedSpace = { ...fullyLoadedSpace, id: 'partially-loaded', name: 'Space with older history' };
    projectClient.listProjectsWithActivity.mockResolvedValue([fullyLoadedSpace, pagedSpace]);
    state.session.sessions = [
      { ...blank, id: 'first-placeholder', projectId: fullyLoadedSpace.id },
      { ...blank, id: 'second-placeholder', projectId: fullyLoadedSpace.id },
      { ...blank, id: 'latest-placeholder', projectId: pagedSpace.id },
    ];

    const { result } = renderSidebar();

    await waitFor(() => {
      expect(result.current.workspaceGroupedSessions.map((group) => group.projectId))
        .toEqual([fullyLoadedSpace.id]);
    });
    expect(result.current.visibleSessionIds).toEqual([]);
  });

  it('keeps a blank row with a runtime or non-idle task state visible before the count updates', () => {
    state.session.sessionRuntimes.set(blank.id, { lastActivityAt: 20 });
    state.session.sessions.push({ ...blank, id: 'running' }, { ...blank, id: 'idle' });
    state.task.sessionStates = { running: { status: 'running' }, idle: { status: 'idle' } };

    const { result } = renderSidebar();
    const ids = result.current.filteredSessions.map((session) => session.id);
    expect(ids).toContain(blank.id);
    expect(ids).toContain('running');
    expect(ids).not.toContain('idle');
  });

  it('keeps placeholder titles with messages and preserves archived and named empty rows', () => {
    state.session.sessions.push(
      { ...blank, id: 'has-messages', messageCount: 1 },
      { ...blank, id: 'archived', status: 'archived' },
      { ...blank, id: 'named', title: 'Release planning' },
    );

    const { result } = renderSidebar();
    expect(result.current.filteredSessions.map((session) => session.id))
      .toEqual(expect.arrayContaining(['has-messages', 'archived', 'named']));
    expect(result.current.searchResultSessions.map((session) => session.id)).not.toContain('archived');
  });

  it('does not resurrect blanks through local title search or host title matches', async () => {
    state.ui.searchQuery = blank.title;
    const titleMatch = { title: blank.title, updatedAt: 10 };
    ipc.invoke.mockImplementation(async (channel: string) => channel === IPC_CHANNELS.SESSION_SEARCH
      ? {
          results: [],
          titleMatches: [
            { ...titleMatch, sessionId: blank.id, messageCount: 0 },
            { ...titleMatch, sessionId: 'unloaded-blank', messageCount: 0 },
            { ...titleMatch, sessionId: 'unloaded-with-messages', messageCount: 2 },
          ],
        }
      : {});

    const { result } = renderSidebar();
    expect(result.current.filteredSessions).toEqual([]);
    await waitFor(() => {
      expect(result.current.searchResultSessions.map((session) => session.id)).toEqual(['unloaded-with-messages']);
    });
  });
});
