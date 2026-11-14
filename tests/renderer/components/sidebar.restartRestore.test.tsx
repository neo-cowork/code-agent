// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatus, AuthUser, Session } from '../../../src/shared/contract';
import { IPC_CHANNELS, IPC_DOMAINS, type AuthEvent } from '../../../src/shared/ipc';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../../src/shared/constants';

const boundary = vi.hoisted(() => ({
  invoke: vi.fn(),
  error: vi.fn(),
  listeners: new Set<(event: AuthEvent) => void>(),
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ error: boundary.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(async () => undefined),
    invokeDomain: vi.fn(async () => []),
    on: (channel: string, listener: (event: AuthEvent) => void) => {
      if (channel === IPC_CHANNELS.AUTH_EVENT) boundary.listeners.add(listener);
      return () => boundary.listeners.delete(listener);
    },
  },
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { Sidebar } from '../../../src/renderer/components/Sidebar';
import { SessionExpiredNotice } from '../../../src/renderer/components/SessionExpiredNotice';
import { ToastContainer } from '../../../src/renderer/components/Toast';
import { initializeAuthStore, useAuthStore } from '../../../src/renderer/stores/authStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { resetSessionListLoadState } from '../../../src/renderer/stores/sessionListPagination';
import { useSessionUIStore } from '../../../src/renderer/stores/sessionUIStore';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';

const user: AuthUser = { id: 'restore-user', email: 'restore@example.test', nickname: 'Restored Account' };
const restored: AuthStatus = { isAuthenticated: true, user, isLoading: false, sessionTrustState: 'verified' };
const expired: AuthStatus = { isAuthenticated: false, user: null, isLoading: false, sessionExpired: true };
const expiredEvent: AuthEvent = { type: 'signed_out', sessionExpired: true };
const groupNames = ['project-alpha', 'project-beta', '任务_1111_周报'];
const sessions: Session[] = groupNames.map((name, index) => ({
  id: `restore-${index}`, title: index === 2 ? `${name}_整理资料` : `${name} work`,
  workingDirectory: `/repo/${name}`, projectId: index < 2 ? name : undefined, createdAt: 1, updatedAt: 2,
  modelConfig: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
let authResult: () => Promise<AuthStatus>;
let listResult: () => Promise<Session[]>;
const originalDomainAPI = window.domainAPI;

beforeEach(() => {
  vi.clearAllMocks();
  boundary.listeners.clear();
  authResult = async () => restored;
  listResult = async () => sessions;
  boundary.invoke.mockImplementation(async (domain: string, action: string) => {
    if (domain === IPC_DOMAINS.AUTH && action === 'getStatus') return { success: true, data: await authResult() };
    if (domain === IPC_DOMAINS.SESSION && action === 'list') return { success: true, data: await listResult() };
    if (domain === IPC_DOMAINS.SYNC) return { success: true, data: useAuthStore.getInitialState().syncStatus };
    return { success: true, data: [] };
  });
  // Only the invoke boundary is used; retain the bridge's other production fields.
  window.domainAPI = { ...originalDomainAPI, invoke: boundary.invoke };
  useAuthStore.setState(useAuthStore.getInitialState());
  useSessionStore.setState(useSessionStore.getInitialState());
  useSessionUIStore.setState(useSessionUIStore.getInitialState());
  useAppStore.setState({ language: 'zh' });
  resetSessionListLoadState();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.domainAPI = originalDomainAPI;
  boundary.listeners.clear();
  useToastStore.setState({ toasts: [] });
});
function mount() {
  return render(<><Sidebar /><SessionExpiredNotice /><ToastContainer /></>);
}
function expectAccount(name: string) {
  expect(within(screen.getByRole('button', { name: zh.sidebar.userMenu })).getByText(name)).toBeTruthy();
  expect(screen.queryByRole('button', { name: zh.sidebar.signIn })).toBeNull();
  expect(screen.queryByTestId('sidebar-signed-out-footer')).toBeNull();
  expect(screen.queryByText('登录', { exact: true })).toBeNull();
}
function expectPending() {
  expect(screen.getByTestId('sidebar-account-loading')).toBeTruthy();
  expect(screen.queryByRole('button', { name: zh.sidebar.userMenu })).toBeNull();
  expect(screen.queryByTestId('sidebar-signed-out-footer')).toBeNull();
  expect(screen.queryByText('登录', { exact: true })).toBeNull();
}
function expectGroups() {
  for (const name of groupNames) {
    expect(screen.getByText(name, { exact: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: zh.sidebarProject.moreActions.replace('{name}', name) })).toBeTruthy();
    expect(screen.getByRole('button', { name: zh.sidebarProject.newSessionIn.replace('{name}', name) })).toBeTruthy();
  }
  expect(screen.queryByTestId('sidebar-list-loading')).toBeNull();
}
async function loadList() {
  await act(async () => { await useSessionStore.getState().loadSessions(); });
}

describe('Sidebar restart restore through initializeAuthStore', () => {
  it('restore ok: neutral placeholder until getStatus settles, then account while list is pending, then restores all groups', async () => {
    const list = deferred<Session[]>();
    listResult = () => list.promise;
    mount();
    await act(async () => {
      const initialization = initializeAuthStore();
      try { expectPending(); }
      finally { await initialization; }
    });
    let loading!: Promise<void>;
    act(() => { loading = useSessionStore.getState().loadSessions(); });
    expect(screen.getByTestId('sidebar-list-loading')).toBeTruthy();
    expect(screen.queryByText(zh.sidebar.noSessions)).toBeNull();
    for (const name of groupNames) {
      expect(screen.queryByRole('button', { name: zh.sidebarProject.moreActions.replace('{name}', name) })).toBeNull();
    }
    expectAccount(user.nickname!);
    await act(async () => { await initializeAuthStore(); });
    expectAccount(user.nickname!);
    expect(screen.getByTestId('sidebar-list-loading')).toBeTruthy();
    await act(async () => { list.resolve(sessions); await loading; });
    expectAccount(user.nickname!);
    expectGroups();
  });

  it('expired: shows sign-in and the reconnect toast exactly once without changing groups', async () => {
    authResult = async () => expired;
    await loadList();
    mount();
    await act(async () => { await initializeAuthStore(); });
    await act(async () => {
      for (let repeat = 0; repeat < 3; repeat += 1) {
        for (const listener of boundary.listeners) listener(expiredEvent);
      }
    });
    expect(within(screen.getByTestId('sidebar-signed-out-footer')).getByRole('button', { name: zh.sidebar.signIn })).toBeTruthy();
    expect(screen.getAllByText(zh.common.sessionExpiredReconnect)).toHaveLength(1);
    expect(useToastStore.getState().toasts.filter((toast) => toast.message === zh.common.sessionExpiredReconnect)).toHaveLength(1);
    expectGroups();
  });

  it('read failure (host get_session_error): degrades unknown identity once and retries a failed list', async () => {
    // Host reason is pinned by authServiceTrust.test.ts:
    // "getSession error with cached identity → warn reason get_session_error with message and numeric status".
    authResult = async () => { throw new Error('status read failed'); };
    listResult = async () => { throw new Error('list read failed'); };
    mount();
    await act(async () => { await initializeAuthStore(); });
    await loadList();
    const account = screen.getByTestId('sidebar-account-unreachable');
    expect(within(account).getByText(zh.sidebar.accountUnreachable)).toBeTruthy();
    expect(within(account).getByRole('button', { name: zh.sidebar.signedOutSettings })).toBeTruthy();
    expect(screen.queryByTestId('sidebar-signed-out-footer')).toBeNull();
    expect(screen.queryByRole('button', { name: zh.sidebar.signIn })).toBeNull();
    expect(boundary.error.mock.calls.filter(([message]) => message === 'Failed to load auth status')).toHaveLength(1);
    await act(async () => { fireEvent.click(within(account).getByRole('button', { name: zh.sidebar.connectionRetry })); });
    expect(screen.getByTestId('sidebar-account-unreachable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: zh.sidebar.signIn })).toBeNull();
    expect(within(screen.getByTestId('sidebar-list-error')).getByText(zh.sidebar.loadSessionsFailed)).toBeTruthy();
    listResult = async () => sessions;
    await act(async () => { fireEvent.click(within(screen.getByTestId('sidebar-list-error')).getByRole('button', { name: zh.sidebar.retryLoadSessions })); });
    expect(screen.queryByTestId('sidebar-list-error')).toBeNull();
    expectGroups();
    // A confirmed signed-out response still restores the existing sign-in footer.
    authResult = async () => ({ isAuthenticated: false, user: null, isLoading: false });
    await act(async () => { await initializeAuthStore(); });
    expect(screen.queryByTestId('sidebar-account-unreachable')).toBeNull();
    expect(within(screen.getByTestId('sidebar-signed-out-footer')).getByRole('button', { name: zh.sidebar.signIn })).toBeTruthy();
    expectGroups();
  });

  it('delayed: shows neutral placeholder (never 登录) with groups visible until late getStatus resolves', async () => {
    vi.useFakeTimers();
    await loadList();
    authResult = () => new Promise<AuthStatus>((resolve) => { setTimeout(() => resolve(restored), 1000); });
    mount();
    let initialization!: Promise<void>;
    act(() => { initialization = initializeAuthStore(); });
    await act(async () => {
      try { expectPending(); expectGroups(); }
      finally { await vi.advanceTimersByTimeAsync(999); }
    });
    expectPending();
    expectGroups();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); await initialization; });
    expectAccount(user.nickname!);
    expectGroups();
  });
});
