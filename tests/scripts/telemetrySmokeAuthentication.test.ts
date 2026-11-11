import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), launch: vi.fn(), finish: vi.fn() }));
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (p: string) => p.startsWith('dist/') || actual.existsSync(p) };
});
vi.mock('child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: mocks.spawn }));
vi.mock('../../scripts/verify-slotless.mjs', () => ({ readDogfoodCredentials: () => ({ email: 'dogfood@example.test', password: 'fixture-password', tokenRhythmKey: 'sk_tr_fixture' }) }));
vi.mock('../../scripts/acceptance/_helpers.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../../scripts/acceptance/_helpers.ts')>(),
  parseArgs: () => ({ positionals: [], options: { 'skip-build': true } }),
  finishWithError: mocks.finish,
}));
vi.mock('../../scripts/acceptance/browser-computer-system-chrome.ts', () => ({
  getFreePort: async () => 49199, launchSystemChromeSession: mocks.launch,
  closeSystemChromeSession: vi.fn(async () => undefined), formatAcceptanceError: String,
}));
let home: string;
let requests: Array<{ path: string; body: unknown }>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  home = mkdtempSync(path.join(os.tmpdir(), 'telemetry-auth-'));
  vi.stubEnv('HOME', home);
  requests = [];
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null,
      signalCode: null as string | null, killed: false,
      kill: () => { child.killed = true; child.signalCode = 'SIGTERM'; child.emit('close'); return true; },
    });
    return child;
  });
  mocks.launch.mockResolvedValue({ browser: { newPage: async () => ({
    waitForResponse: async () => null, goto: async () => undefined,
    evaluate: async () => 'fixture-server-token',
    locator: (selector: string) => {
      if (selector !== 'body') throw new Error('STOP_AFTER_AUTH');
      return { waitFor: async () => undefined };
    },
  }) } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const route = new URL(url).pathname;
    requests.push({ path: route, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(route.endsWith('/signInEmail')
      ? { success: true, data: { success: true, user: { email: 'dogfood@example.test', isAdmin: false } } }
      : { status: 'ok' }), { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }); });

describe('telemetry smoke establishes its own upload identity', () => {
  it.each([false, true])('signs in dogfood before seeding telemetry (owner config present=%s)', async (configured) => {
    if (configured) {
      mkdirSync(path.join(home, '.code-agent'));
      writeFileSync(path.join(home, '.code-agent/config.json'), '{"models":{}}');
    }
    await import('../../scripts/acceptance/telemetry-feedback-cloud-smoke');
    await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalled());
    expect(requests.map(r => r.path)).toContain('/api/domain/auth/signInEmail');
    expect(requests.find(r => r.path.endsWith('/signInEmail'))?.body).toEqual({ payload: { email: 'dogfood@example.test', password: 'fixture-password' } });
    expect(String(mocks.finish.mock.calls[0]?.[0])).toContain('STOP_AFTER_AUTH');
    const env = mocks.spawn.mock.calls[0][2].env;
    expect(env.HOME).toBe(env.CODE_AGENT_DATA_DIR);
    expect(env.HOME).not.toBe(home);
  });
});
