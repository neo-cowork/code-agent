import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDogfoodVerificationAccount, resolveDevVerificationDataDir, signInDogfoodVerificationAccount } from '../../scripts/lib/verificationAccount';

vi.mock('../../scripts/verify-slotless.mjs', () => ({ readDogfoodCredentials: () => ({ email: 'dogfood@example.test', password: 'fixture-password' }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const dogfood = { isAuthenticated: true, sessionTrustState: 'verified', hasCachedAdminClaim: false, user: { email: 'dogfood@example.test', isAdmin: false } };

describe('already-running Dev app account admission', () => {
  it.each([1, 2, 7, 9])('resolves the actual installed slot %s token/log path', (slot) => {
    expect(resolveDevVerificationDataDir(`http://127.0.0.1:${8180 + slot}`)).toBe(path.join(os.homedir(), slot === 1 ? '.code-agent-dev' : `.code-agent-dev${slot}`));
  });

  it('keeps explicit isolated paths usable on ephemeral ports', () => {
    expect(resolveDevVerificationDataDir('http://127.0.0.1:49001', '/isolated/fixture')).toBe('/isolated/fixture');
    expect(() => resolveDevVerificationDataDir('http://127.0.0.1:49001')).toThrow(/explicit data directory/);
  });

  it('admits a verified non-admin dogfood account using only read-only getStatus', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ success: true, data: dogfood })));
    vi.stubGlobal('fetch', fetch);
    await expect(assertDogfoodVerificationAccount('http://127.0.0.1:8182', 'fixture-local-token')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe('http://127.0.0.1:8182/api/domain/auth/getStatus');
  });

  it.each([
    { ...dogfood, user: { email: 'owner@example.test', isAdmin: false } },
    { ...dogfood, user: { email: 'owner@example.test', isAdmin: true } },
    { ...dogfood, sessionTrustState: 'cached' },
    { ...dogfood, hasCachedAdminClaim: true },
    { ...dogfood, user: { email: 'local-web-test-user@code-agent.local', isAdmin: true } },
    { ...dogfood, isAuthenticated: false },
  ])('refuses owner, cached, synthetic or signed-out identity %# without signing in or changing it', async status => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ success: true, data: status })));
    vi.stubGlobal('fetch', fetch);
    await expect(assertDogfoodVerificationAccount('http://127.0.0.1:8182', 'fixture-local-token')).rejects.toThrow(/verified non-admin dogfood/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/auth/getStatus');
  });

  it('fails closed on wrong bearer tokens and refuses non-loopback auth destinations', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { status: 401 })));
    await expect(assertDogfoodVerificationAccount('http://127.0.0.1:8182', 'wrong-token')).rejects.toThrow(/HTTP 401/);
    await expect(signInDogfoodVerificationAccount('https://example.test', 'fixture')).rejects.toThrow(/loopback/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('fresh isolated telemetry host sign-in', () => {
  it('checks the real sign-in reply without polluting the telemetry --json output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ success: true, data: { success: true, user: dogfood.user } })));
    vi.stubGlobal('fetch', fetch);
    await signInDogfoodVerificationAccount('http://127.0.0.1:49001', 'fixture');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('/auth/signInEmail');
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects failed actual sign-in even when HTTP succeeded', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ success: true, data: { success: false } }))));
    await expect(signInDogfoodVerificationAccount('http://127.0.0.1:49001', 'fixture')).rejects.toThrow(/sign-in was rejected/);
  });
});
