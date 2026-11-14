// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarAccountStatus } from '../../../src/renderer/components/features/sidebar/SidebarAccountStatus';
import { SidebarSessionList, type SidebarSessionListProps } from '../../../src/renderer/components/features/sidebar/SidebarSessionList';
import { ModelSlot } from '../../../src/renderer/components/StatusBar/ModelSlot';
import { initializeAuthStore, useAuthStore } from '../../../src/renderer/stores/authStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { executeLoadSessions, resetSessionListLoadState, useSessionListLoadStore } from '../../../src/renderer/stores/sessionListPagination';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh, en } from '../../../src/renderer/i18n';
import ipcService from '../../../src/renderer/services/ipcService';

vi.mock('../../../src/renderer/services/ipcService', async (original) => ({
  ...await original<typeof import('../../../src/renderer/services/ipcService')>(),
  default: { ...(await original<typeof import('../../../src/renderer/services/ipcService')>()).default, on: vi.fn(() => vi.fn()), isAvailable: () => false },
}));

const invoke = vi.fn();
const props = {
  groups: [], isLoading: false, hasAnySessions: false, filteredSessionsEmpty: true,
  messageSearchLoading: false, searchQuery: '', sessionStatusFilter: 'all',
  activeStatusFilterLabel: '', hasSearchFilters: false, projectMetaById: {},
  expandedWorkspaces: {}, collapsingWorkspaces: {}, expandedProjectDetails: {},
  projectDrawerKey: null, isCreatingSession: false, creatingWorkspaceKey: null,
  sessionItemProps: {
    backgroundSessionMap: new Map(), sessionRuntimes: new Map(), sessionStates: {},
    hasNeedsInputForSession: () => false, replayEvidenceBySessionId: new Map(),
    reviewItemsBySessionId: {}, currentSessionId: null,
  },
  handleNewChat: vi.fn(), handleNewIndependentSpace: vi.fn(),
} as unknown as SidebarSessionListProps;

beforeEach(() => {
  resetSessionListLoadState();
  invoke.mockReset().mockRejectedValue(new Error('Network unavailable'));
  Object.defineProperty(window, 'domainAPI', { configurable: true, value: { invoke } });
  useAuthStore.setState({ statusLoadFailed: false, isAuthenticated: false, user: null, isLoading: true });
  useAppStore.setState({ language: 'en', settingsLoaded: false, showSettings: false });
  useSessionStore.setState({ sessions: [], error: null, isLoading: false, hasOlderSessions: false });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('startup unavailable placeholders through public entries', () => {
  it.each([['zh', zh], ['en', en]] as const)('initializeAuthStore rejection shows unreachable with Retry and Settings, never sign-in (%s)', async (language, t) => {
    useAppStore.setState({ language });
    await initializeAuthStore();
    render(<SidebarAccountStatus />);
    expect(screen.getByText(t.sidebar.accountUnreachable)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.sidebar.signIn })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t.sidebar.connectionRetry }));
    await waitFor(() => expect(invoke.mock.calls.filter(([domain]) => domain === IPC_DOMAINS.AUTH)).toHaveLength(2));
    await waitFor(() => expect((screen.getByRole('button', { name: t.sidebar.connectionRetry }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: t.sidebar.signIn })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t.sidebar.signedOutSettings }));
    expect(useAppStore.getState().showSettings).toBe(true);
    // Retrying initialization replaces event subscriptions instead of accumulating listeners.
    const subscriptions = vi.mocked(ipcService.on).mock.results.slice(0, 3);
    subscriptions.forEach(({ value }) => expect(value).toHaveBeenCalledOnce());
  });

  it('initializeAuthStore success with user null clears failure and shows sign-in', async () => {
    await initializeAuthStore();
    invoke.mockResolvedValue({ success: true, data: { user: null } });
    await initializeAuthStore();
    render(<SidebarAccountStatus />);
    expect(useAuthStore.getState().statusLoadFailed).toBe(false);
    expect(screen.getByRole('button', { name: en.sidebar.signIn })).toBeTruthy();
    expect(screen.queryByTestId('sidebar-account-unreachable')).toBeNull();
  });

  it('executeLoadSessions failure renders the real list failure gate and Retry calls loadSessions', async () => {
    await executeLoadSessions({ get: useSessionStore.getState, set: useSessionStore.setState });
    render(<SidebarSessionList {...props} />);
    expect(screen.getByText(en.sidebar.loadSessionsFailed)).toBeTruthy();
    expect(screen.queryByText(en.sidebar.noSessions)).toBeNull();
    invoke.mockResolvedValue({ success: true, data: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(useSessionListLoadStore.getState().error).toBe(false));
    expect(screen.getByText(en.sidebar.noSessions)).toBeTruthy();
    expect(invoke).toHaveBeenLastCalledWith(IPC_DOMAINS.SESSION, 'list', expect.objectContaining({ offset: 0 }));
  });

  it('an already loaded list survives executeLoadSessions failure alongside a retry notice', async () => {
    const session = { id: 'weekly-report', title: 'Weekly report', createdAt: 1, updatedAt: 1, type: 'chat', messageCount: 2, turnCount: 1 };
    useSessionStore.setState({ sessions: [session] as ReturnType<typeof useSessionStore.getState>['sessions'] });
    await executeLoadSessions({ get: useSessionStore.getState, set: useSessionStore.setState });
    const groups: SidebarSessionListProps['groups'] = [{ key: 'quick', sessions: [], paths: [], isUncategorized: true, name: 'Weekly report', latestActivityAt: 1 }];
    render(<SidebarSessionList {...props} hasAnySessions groups={groups} filteredSessionsEmpty={false} />);
    expect(useSessionStore.getState().sessions[0].title).toBe('Weekly report');
    expect(screen.getByTestId('sidebar-list-error')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-list-loading')).toBeNull();
    expect(screen.queryByText(en.sidebar.noSessions)).toBeNull();
  });

  it('successful empty session list still shows the real empty state', async () => {
    invoke.mockResolvedValue({ success: true, data: [] });
    await executeLoadSessions({ get: useSessionStore.getState, set: useSessionStore.setState });
    render(<SidebarSessionList {...props} />);
    expect(screen.getByText(en.sidebar.noSessions)).toBeTruthy();
    expect(screen.queryByTestId('sidebar-list-error')).toBeNull();
  });

  it.each(['create', 'delete'] as const)('a failed session %s does not claim the empty list failed to load', async (action) => {
    invoke.mockResolvedValueOnce({ success: true, data: [] });
    await useSessionStore.getState().loadSessions();
    if (action === 'create') await useSessionStore.getState().createSession('Weekly report');
    else await useSessionStore.getState().deleteSession('last-session');
    expect(useSessionStore.getState().error).toBeTruthy();
    render(<SidebarSessionList {...props} />);
    expect(screen.getByText(en.sidebar.noSessions)).toBeTruthy();
    expect(screen.queryByTestId('sidebar-list-error')).toBeNull();
  });

  it.each([false, true])('silent list success clears list failure even when the list signature is unchanged (%s)', async (changed) => {
    await useSessionStore.getState().loadSessions();
    render(<SidebarSessionList {...props} />);
    expect(screen.getByText(en.sidebar.loadSessionsFailed)).toBeTruthy();
    const session = { id: 'weekly-report', title: 'Weekly report', createdAt: 1, updatedAt: 1 };
    invoke.mockResolvedValue({ success: true, data: changed ? [session] : [] });
    await act(async () => { await useSessionStore.getState().loadSessions({ silent: true }); });
    expect(screen.queryByTestId('sidebar-list-error')).toBeNull();
    expect(screen.getByText(en.sidebar.noSessions)).toBeTruthy();
  });

  it.each([['zh', zh], ['en', en]] as const)('model Retry recovers configured switcher after settings failure without a page reload (%s)', async (language, t) => {
    useAppStore.setState({ language });
    function CurrentModelSlot() {
      const model = useAppStore((state) => state.modelConfig.model);
      return <ModelSlot currentModel={model} />;
    }
    render(<CurrentModelSlot />);
    fireEvent.click(screen.getByRole('button', { name: t.sidebar.connectionRetry }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'get', undefined));
    await waitFor(() => expect((screen.getByRole('button', { name: t.sidebar.connectionRetry }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText(t.sidebar.modelLoading)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /切换模型|Switch model/ })).toBeNull();
    invoke.mockResolvedValue({ success: true, data: { models: { default: 'xiaomi', providers: { xiaomi: { model: 'mimo-v2.6-flash' } } } } });
    fireEvent.click(screen.getByRole('button', { name: t.sidebar.connectionRetry }));
    await waitFor(() => expect(screen.getByRole('button', { name: /切换模型|Switch model/ }).textContent).toContain('MiMo'));
    expect(useAppStore.getState().settingsLoaded).toBe(true);
    expect(screen.queryByTestId('model-loading')).toBeNull();
  });

  it('model Retry accepts successful settings without a configured model', async () => {
    invoke.mockResolvedValue({ success: true, data: {} });
    render(<ModelSlot currentModel="glm-5.3" />);
    fireEvent.click(screen.getByRole('button', { name: en.sidebar.connectionRetry }));
    await waitFor(() => expect(screen.getByRole('button', { name: /切换模型|Switch model/ })).toBeTruthy());
    expect(useAppStore.getState().settingsLoaded).toBe(true);
  });

  it.each([['zh', zh], ['en', en]] as const)('real model slot hides defaults until settingsLoaded, then shows configured model (%s)', (language, t) => {
    useAppStore.setState({ language });
    const view = render(<ModelSlot currentModel={useAppStore.getState().modelConfig.model} />);
    expect(screen.getByText(t.sidebar.modelLoading)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /切换模型|Switch model/ })).toBeNull();
    act(() => useAppStore.setState({ settingsLoaded: true }));
    view.rerender(<ModelSlot currentModel="glm-5.3" />);
    expect(screen.getByRole('button', { name: /切换模型|Switch model/ }).textContent).toContain('GLM-5.3');
    expect(screen.queryByTestId('model-loading')).toBeNull();
  });
});
