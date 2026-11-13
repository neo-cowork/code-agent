// @vitest-environment jsdom
// 真 supabase-js + 本地 stub：refresh 返回 invalid_grant 时，SIGNED_OUT 与刷新请求有界，且只弹一次过期 toast。
import http from 'http';
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IPC_CHANNELS, type AuthEvent } from '../../../../src/shared/ipc';
import { SessionExpiredNotice } from '../../../../src/renderer/components/SessionExpiredNotice';
import ipcService from '../../../../src/renderer/services/ipcService';
import { useToastStore } from '../../../../src/renderer/hooks/useToast';
import { useAuthStore } from '../../../../src/renderer/stores/authStore';
import { useAppStore } from '../../../../src/renderer/stores/appStore';
import type { Database } from '../../../../src/host/services/infra/supabaseService';

const state = vi.hoisted(() => ({
  local: new Map<string, string>(),
  keychain: null as string | null,
  keychainReads: 0,
  keychainHits: 0,
  keychainReadArgs: [] as unknown[],
  sessionKeys: [] as string[],
  storage: null as null | { getItem(key: string): Promise<string | null> },
}));

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../../src/host/services/core', () => ({
  getSecureStorage: () => ({
    getItem: async (key: string) => state.local.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      state.local.set(key, value);
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) state.sessionKeys.push(key);
    },
    removeItem: async (key: string) => {
      state.local.delete(key);
    },
    getSessionFromKeychain: async (...args: unknown[]) => {
      state.keychainReads += 1;
      state.keychainReadArgs.push(args);
      if (state.keychain) state.keychainHits += 1;
      return state.keychain;
    },
    saveSessionToKeychain: async (value: string) => {
      state.keychain = value;
    },
    clearSessionFromKeychain: async () => {
      state.keychain = null;
    },
  }),
}));

vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => loggerMock,
}));

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const options = args[2] as { auth?: { storage?: { getItem(key: string): Promise<string | null> } } } | undefined;
      state.storage = options?.auth?.storage ?? null;
      return actual.createClient(...args);
    },
  };
});

describe('dead refresh token does not loop', () => {
  const previousDisableProxy = process.env.DISABLE_PROXY;
  let server: http.Server | null = null;
  let client: SupabaseClient<Database> | null = null;

  afterEach(async () => {
    cleanup();
    if (client) {
      await client.auth.stopAutoRefresh();
      client.realtime.disconnect();
      client = null;
    }
    if (server) {
      const closing = server;
      server = null;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
    if (previousDisableProxy === undefined) delete process.env.DISABLE_PROXY;
    else process.env.DISABLE_PROXY = previousDisableProxy;
    vi.restoreAllMocks();
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();
    useToastStore.setState({ toasts: [] });
    useAuthStore.setState({ showAuthModal: false });
  });

  it('N refresh failures keep SIGNED_OUT, refresh requests, and the toast bounded', async () => {
    process.env.DISABLE_PROXY = 'true';
    const hits: string[] = [];
    let refreshRequests = 0;
    let passwordGrants = 0;
    let releaseRefresh: () => void = () => {};
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      hits.push(`${req.method ?? 'GET'} ${url.pathname}${url.search}`);
      req.resume();
      const isToken = req.method === 'POST' && url.pathname.endsWith('/token');
      const grant = url.searchParams.get('grant_type');
      if (isToken && grant === 'password') {
        passwordGrants += 1;
        const expiresIn = 3600;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: expiresIn,
          expires_at: Math.floor(Date.now() / 1000) + expiresIn,
          token_type: 'bearer',
          user: {
            id: 'user-1',
            aud: 'authenticated',
            role: 'authenticated',
            email: 'user@example.com',
          },
        }));
        return;
      }
      const isRefresh = isToken && grant === 'refresh_token';
      if (!isRefresh) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      refreshRequests += 1;
      const respond = () => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Invalid Refresh Token',
        }));
      };
      if (refreshRequests === 1) {
        void refreshHeld.then(respond);
        return;
      }
      respond();
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('stub server has no port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    state.local.clear();
    state.sessionKeys.length = 0;
    state.keychainReads = 0;
    state.keychainHits = 0;
    state.keychain = JSON.stringify({
      access_token: 'dead-access',
      refresh_token: 'dead-refresh',
      expires_at: 1,
      expires_in: 0,
      token_type: 'bearer',
      user: { id: 'user-1', aud: 'authenticated', role: 'authenticated' },
    });

    let noticeListener: ((event: AuthEvent) => void) | null = null;
    vi.spyOn(ipcService, 'on').mockImplementation((channel, callback) => {
      if (channel === IPC_CHANNELS.AUTH_EVENT) {
        noticeListener = callback as (event: AuthEvent) => void;
      }
      return () => {};
    });
    useAppStore.setState({ language: 'zh' });
    useAuthStore.setState({ showAuthModal: false });
    useToastStore.setState({ toasts: [] });
    render(React.createElement(SessionExpiredNotice));
    act(() => {
      noticeListener?.({ type: 'signed_in' });
    });
    useToastStore.setState({ toasts: [] });

    const { initSupabase } = await import('../../../../src/host/services/infra/supabaseService');
    client = initSupabase(baseUrl, 'anon-key');
    let signedOutEvents = 0;
    client.auth.onAuthStateChange((event) => {
      if (event !== 'SIGNED_OUT') return;
      signedOutEvents += 1;
      act(() => {
        noticeListener?.({ type: 'signed_out', sessionExpired: true });
      });
    });
    releaseRefresh();
    await client.auth.initialize();
    // auth-js 在 initialize 的 finally 里用 setTimeout(0) 再跑一轮 auto-refresh tick。
    // 这里只等那一轮排空，不是在编码任何刷新间隔。
    await new Promise((resolve) => setTimeout(resolve, 30));

    const attempts = 8;
    for (let i = 0; i < attempts; i += 1) {
      await client.auth.getSession();
    }

    const sessionKey = state.sessionKeys[0];
    expect(sessionKey, hits.join('\n')).toBeTruthy();
    await expect(state.storage?.getItem(sessionKey!)).resolves.toBeNull();
    expect(refreshRequests, hits.join('\n')).toBeGreaterThan(0);
    expect(refreshRequests).toBeLessThanOrEqual(2);
    expect(refreshRequests).toBeLessThan(attempts);
    expect(signedOutEvents).toBeGreaterThan(0);
    expect(signedOutEvents).toBeLessThanOrEqual(2);
    expect(signedOutEvents).toBeLessThan(attempts);
    expect(state.keychainHits).toBeLessThanOrEqual(2);
    expect(state.keychainHits).toBeLessThan(attempts);
    expect(state.keychain).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(1);

    const refreshBeforeSignIn = refreshRequests;
    const signedOutBeforeSignIn = signedOutEvents;
    const signedIn = await client.auth.signInWithPassword({
      email: 'user@example.com',
      password: 'correct-password',
    });
    expect(signedIn.error).toBeNull();
    expect(signedIn.data.session?.refresh_token).toBe('fresh-refresh');
    expect(state.keychain).toContain('fresh-refresh');
    expect(passwordGrants).toBe(1);
    expect(refreshRequests).toBe(refreshBeforeSignIn);
    expect(signedOutEvents).toBe(signedOutBeforeSignIn);
    const restored = await client.auth.getSession();
    expect(restored.data.session?.access_token).toBe('fresh-access');

    // FB 03：adapter 的两级降级哨——removeItem 宣告 refresh 被拒、getItem 两级皆空。
    // 都是每进程至多一次，重重复的 getSession/removeItem 不得刷屏。
    expect(state.keychainReadArgs.length).toBeGreaterThan(0);
    for (const args of state.keychainReadArgs) {
      expect(args).toEqual([{ forSessionRead: true }]);
    }
    const warnsByReason = (reason: string) => loggerMock.warn.mock.calls.filter(
      ([, fields]) => (fields as { reason?: string } | undefined)?.reason === reason,
    );
    expect(warnsByReason('refresh_rejected_session_removed')).toHaveLength(1);
    expect(warnsByReason('session_storage_empty')).toHaveLength(1);
    expect(warnsByReason('keychain_module_unavailable')).toHaveLength(0);

    // 降级 warn 参数不落 token / email（真实 refresh 失败流里它们都在场）
    const loggedWarns = JSON.stringify(loggerMock.warn.mock.calls);
    expect(loggedWarns).not.toContain('dead-refresh');
    expect(loggedWarns).not.toContain('dead-access');
    expect(loggedWarns).not.toContain('fresh-refresh');
    expect(loggedWarns).not.toContain('user@example.com');
  });
});
