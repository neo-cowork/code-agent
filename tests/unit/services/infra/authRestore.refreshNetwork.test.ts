// Real auth-js + local HTTP stub, entered through AuthService (no mocked auth events).
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../../src/host/services/infra/supabaseService';

const state = vi.hoisted(() => ({ values: new Map<string, string>(), removed: [] as string[] }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../../src/host/services/infra/logger', () => ({ createLogger: () => log }));
vi.mock('../../../../src/host/platform', () => ({ shell: { openExternal: vi.fn() } }));
vi.mock('../../../../src/host/services/cloudRun/cloudRunLedger', () => ({ bindCloudRunAccountSource: vi.fn() }));
vi.mock('../../../../src/host/services/core', () => ({
  getConfigService: () => ({ getSettings: () => ({}) }),
  getSecureStorage: () => ({
    get: (key: string) => state.values.get(key),
    set: (key: string, value: string) => state.values.set(key, value),
    delete: (key: string) => { state.removed.push(key); state.values.delete(key); },
    getItem: async (key: string) => state.values.get(key) ?? null,
    setItem: async (key: string, value: string) => { state.values.set(key, value); },
    removeItem: async (key: string) => { state.removed.push(key); state.values.delete(key); },
    getSessionFromKeychain: async () => null,
    saveSessionToKeychain: async () => {},
    clearSessionFromKeychain: async () => {},
    hasStoredSupabaseSession: async () => state.values.has('sb-127-auth-token'),
    hasAnyPastLoginTrace: () => false,
  }),
}));

describe('AuthService real refresh network restore', () => {
  let server: http.Server;
  let client: SupabaseClient<Database> | undefined;
  let recovered = false;
  let refreshRequests = 0;
  const events: string[] = [];

  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); state.values.clear(); state.removed.length = 0;
    recovered = false; refreshRequests = 0; events.length = 0;
    vi.stubEnv('DISABLE_PROXY', 'true');
    // Advance only the clock at a failed HTTP response to exhaust auth-js's bounded
    // retry window without sleeping 30s. The real ticker is still driven below.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  });
  afterEach(async () => {
    if (client) { await client.auth.stopAutoRefresh(); client.realtime.disconnect(); }
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    vi.useRealTimers(); vi.unstubAllEnvs();
  });

  it('keeps cached identity for INITIAL_SESSION null and resolved retryable getSession; next auto-refresh tick verifies without restart', async () => {
    const user = { id: 'restore-user', email: 'restore@example.test', aud: 'authenticated', role: 'authenticated' };
    server = http.createServer((req, res) => {
      req.resume(); res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/auth/v1/token')) {
        refreshRequests += 1;
        if (!recovered) {
          vi.setSystemTime(Date.now() + 31_000);
          res.writeHead(503); res.end('{"message":"socket hang up"}'); return;
        }
        res.end(JSON.stringify({ access_token: 'recovered-access', refresh_token: 'recovered-refresh',
          expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }));
        return;
      }
      res.end(JSON.stringify({ id: user.id, nickname: 'Riley', is_admin: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('stub missing port');
    state.values.set('auth.user', JSON.stringify({ ...user, nickname: 'Riley', isAdmin: true }));
    const originalIdentity = state.values.get('auth.user');
    state.values.set('sb-127-auth-token', JSON.stringify({ access_token: 'expired-access', refresh_token: 'retained-refresh', expires_at: 1, token_type: 'bearer', user }));
    const { initSupabase } = await import('../../../../src/host/services/infra/supabaseService');
    client = initSupabase(`http://127.0.0.1:${address.port}`, 'local-anon');
    client.auth.onAuthStateChange((event) => { events.push(event); });
    const { getAuthService } = await import('../../../../src/host/services/auth/authService');
    const auth = getAuthService();
    await auth.initialize();
    await vi.waitFor(() => expect(events).toContain('INITIAL_SESSION'));
    await expect(auth.revalidateSession()).resolves.toBe('deferred');
    await expect(auth.getStatus()).resolves.toMatchObject({ isAuthenticated: true, sessionTrustState: 'cached', sessionExpired: false, user: { nickname: 'Riley', isAdmin: false } });
    expect(state.values.get('auth.user')).toBe(originalIdentity);
    expect(state.removed).not.toContain('auth.user');
    expect(state.values.has('sb-127-auth-token')).toBe(true);
    expect(log.warn.mock.calls.filter(([, fields]) => fields?.reason === 'refresh_network_failed')).toHaveLength(1);
    expect(refreshRequests).toBeGreaterThan(0);
    console.log('INITIAL_SESSION null + retryable getSession: cached=true sessionExpired=false auth.user retained; refresh_network_failed warns=1');
    recovered = true;
    const requestsBeforeTick = refreshRequests;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(auth.getSessionTrustState()).toBe('verified'));
    expect(events).toContain('TOKEN_REFRESHED');
    expect(refreshRequests).toBeGreaterThan(requestsBeforeTick);
    await expect(auth.getStatus()).resolves.toMatchObject({ isAuthenticated: true, sessionTrustState: 'verified', sessionExpired: false });
    console.log('next real auth-js auto-refresh tick: TOKEN_REFRESHED trust=verified without restart or revalidate fallback');
    const warns = JSON.stringify(log.warn.mock.calls);
    for (const secret of [user.email, user.id, 'retained-refresh', 'expired-access']) expect(warns).not.toContain(secret);
  });
});
