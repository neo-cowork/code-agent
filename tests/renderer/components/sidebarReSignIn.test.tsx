// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarAccountStatus } from '../../../src/renderer/components/features/sidebar/SidebarAccountStatus';
import { initializeAuthStore, useAuthStore } from '../../../src/renderer/stores/authStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh, en } from '../../../src/renderer/i18n';

vi.mock('../../../src/renderer/services/ipcService', async (original) => ({
  ...await original<typeof import('../../../src/renderer/services/ipcService')>(),
  default: { ...(await original<typeof import('../../../src/renderer/services/ipcService')>()).default, on: vi.fn(() => vi.fn()), isAvailable: () => false },
}));

const invoke = vi.fn();
const failures = {
  'network error': () => Promise.reject(new Error('Network unavailable')),
  'http error envelope': () => Promise.resolve({ success: false, error: { message: 'HTTP_500 session read failed' } }),
} as const;

beforeEach(() => {
  invoke.mockReset();
  Object.defineProperty(window, 'domainAPI', { configurable: true, value: { invoke } });
  useAuthStore.setState({ statusLoadFailed: false, statusLoadFailureCount: 0, isAuthenticated: false, user: null, isLoading: true, showAuthModal: false });
  useAppStore.setState({ language: 'en', settingsLoaded: false, showSettings: false });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const authCalls = () => invoke.mock.calls.filter(([domain]) => domain === IPC_DOMAINS.AUTH).length;

async function retry(label: string, expectedCalls: number) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  await waitFor(() => expect(authCalls()).toBe(expectedCalls));
  await waitFor(() => expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false));
}

describe('sidebar re-login exit after repeated status load failures', () => {
  describe.each(Object.entries(failures))('%s', (_kind, fail) => {
    it.each([['zh', zh], ['en', en]] as const)('shows re-login only after two failed retries, opens the auth modal (%s)', async (language, t) => {
      useAppStore.setState({ language });
      invoke.mockImplementation(fail);
      await initializeAuthStore();
      render(<SidebarAccountStatus />);
      expect(useAuthStore.getState().statusLoadFailureCount).toBe(1);
      expect(screen.queryByRole('button', { name: t.sidebar.reSignIn })).toBeNull();
      await retry(t.sidebar.connectionRetry, 2);
      expect(useAuthStore.getState().statusLoadFailureCount).toBe(2);
      expect(screen.queryByRole('button', { name: t.sidebar.reSignIn })).toBeNull();
      await retry(t.sidebar.connectionRetry, 3);
      expect(useAuthStore.getState().statusLoadFailureCount).toBe(3);
      console.log(`statusLoadFailureCount=${useAuthStore.getState().statusLoadFailureCount} (${_kind}, ${language})`);
      const button = await screen.findByRole('button', { name: t.sidebar.reSignIn });
      expect(screen.getByText(t.sidebar.accountUnreachable)).toBeTruthy();
      expect(screen.queryByRole('button', { name: t.sidebar.signIn })).toBeNull();
      fireEvent.click(button);
      expect(useAuthStore.getState().showAuthModal).toBe(true);
    });
  });

  it.each([['user', { user: { id: 'u1', email: 'a@b.c' } }], ['signed out', { user: null }]] as const)('a successful retry (%s) clears the button and the counter', async (_n, status) => {
    invoke.mockImplementation(failures['network error']);
    await initializeAuthStore();
    render(<SidebarAccountStatus />);
    await retry(en.sidebar.connectionRetry, 2);
    await retry(en.sidebar.connectionRetry, 3);
    await screen.findByRole('button', { name: en.sidebar.reSignIn });
    invoke.mockImplementation(async (domain: string) => (domain === IPC_DOMAINS.AUTH ? { success: true, data: status } : { success: true, data: null }));
    fireEvent.click(screen.getByRole('button', { name: en.sidebar.connectionRetry }));
    await waitFor(() => expect(useAuthStore.getState().statusLoadFailed).toBe(false));
    expect(useAuthStore.getState().statusLoadFailureCount).toBe(0);
    expect(screen.queryByRole('button', { name: en.sidebar.reSignIn })).toBeNull();
  });
});
