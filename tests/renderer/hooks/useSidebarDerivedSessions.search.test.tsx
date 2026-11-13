// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
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
  getProjectDetail: vi.fn(async (projectId: string) => ({
    project: { id: projectId, name: 'Project', status: 'active', description: '', updatedAt: 1 },
    goals: [],
    roles: [],
    sessionIds: ['message-hit', 'metadata-hit', 'archived-hit'],
  })),
  getProjectArtifacts: vi.fn(async () => []),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
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
import { SidebarSearchDialog } from '../../../src/renderer/components/features/sidebar/SidebarSearchDialog';

beforeEach(() => {
  vi.clearAllMocks();
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

  it('keeps the id restriction in current-project scope and ignores remote hits', async () => {
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
        options: { limit: 80, sessionIds: ['message-hit', 'metadata-hit'] },
      });
    });
    expect(screen.getByTestId('ids').textContent).not.toContain('old-session');
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
