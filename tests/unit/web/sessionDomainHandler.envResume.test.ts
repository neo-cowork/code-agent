import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import { harness, databasePorts } from '../host/runtime/envResumeHarness';
import { registerEnvResumeContinuer } from '../../../src/host/runtime/envResumeWaiter';
import { installDomainRoutes } from '../../../src/host/ipc/domainRoutes/registry';
import { defineSessionRoutes } from '../../../src/host/ipc/domainRoutes/sessionRoutes';
import { createWebSessionContext } from '../../../src/web/sessionDomainHandler';
import type { HandlerFn } from '../../../src/host/platform';

vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: () => databasePorts.current }));
const smMocks = vi.hoisted(() => ({ restoreSession: vi.fn(), getMessages: vi.fn(), updateMessage: vi.fn() }));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  // The production continuer wiring (registerAgentContinueRoute) passes no recovery
  // ports, so the continuation falls back to default ports reading the session manager.
  getSessionManager: () => ({
    restoreSession: smMocks.restoreSession,
    getMessages: smMocks.getMessages,
    updateMessage: smMocks.updateMessage,
  }),
}));
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => ({ ...await importOriginal<typeof import('../../../src/host/services/infra/logger')>(), createLogger: () => ({ debug: vi.fn(), info: logs.info, warn: logs.warn, error: vi.fn() }) }));

let fixture: Awaited<ReturnType<typeof harness>> | undefined;
let workspace: string;
afterEach(() => {
  fixture?.close(); fixture = undefined;
  registerEnvResumeContinuer(null);
  vi.restoreAllMocks(); logs.info.mockClear(); logs.warn.mockClear();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

/**
 * In-process restart: park in one harness instance, close it, reopen the same SQLite
 * file in a fresh registry and recover the parked run — the state SIGKILL leaves behind.
 * Real timers (the recovered-run continuation is a real-time production path; the
 * poll interval is 1s, so the whole scenario stays within a few seconds).
 */
async function restartedHarness(write = false) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'env-resume-web-')));
  workspace = directory;
  const file = path.join(directory, 'run.db');
  const parked = await harness(directory, file, write);
  await parked.park();
  parked.close();
  fixture = await harness(directory, file, write);
  await fixture.registry.recoverDurable(Date.now() + 120_001);
  return fixture;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const armedCalls = () => logs.info.mock.calls.filter(([message]) => message === 'Environment auto-continue armed on session return');

function installDomainSessionLoad(): HandlerFn {
  const handlers = new Map<string, HandlerFn>();
  // 与 webServer 生产装配同构：单源表 web 形态 + web context
  installDomainRoutes(
    { handle: (channel, handler) => { handlers.set(channel, handler); } },
    defineSessionRoutes('web'),
    createWebSessionContext({
      getDbAvailable: () => true,
      hasActiveRun: () => false,
      getCurrentSessionId: () => null,
      setCurrentSessionId: () => {},
      getDurableRunReadService: () => undefined,
    }),
  );
  const handler = handlers.get('domain:session');
  if (!handler) throw new Error('domain:session handler was not installed');
  return handler;
}

describe('environment auto-continue arms on domain session load (web context)', () => {
  it('loadSession + decorateLoadedSession through the web route table arms, polls red, then continues on green', async () => {
    const f = await restartedHarness();
    let green = false;
    let probeCalls = 0;
    f.wire(() => { probeCalls++; return Promise.resolve(green ? 'green' : 'red'); });
    smMocks.restoreSession.mockResolvedValue({ id: 'env-session', title: 'Environment fixture', workingDirectory: workspace, createdAt: 1, updatedAt: 1, messages: f.messages() });
    smMocks.getMessages.mockImplementation(async () => f.messages());
    smMocks.updateMessage.mockResolvedValue(undefined);
    const load = installDomainSessionLoad();

    const response = await load(undefined, { action: 'load', payload: { sessionId: 'env-session' } }) as { success: boolean; data: { id: string } | null };
    expect(response).toMatchObject({ success: true, data: { id: 'env-session' } });
    expect(armedCalls()).toEqual([['Environment auto-continue armed on session return', { runId: 'env-run', sessionId: 'env-session', entry: 'domain:session:load' }]]);

    await sleep(1_400); // red poll ticks; the run must stay parked
    expect(probeCalls).toBeGreaterThanOrEqual(1);
    expect(f.counts()).toMatchObject({ executions: 0, resumes: 0 });
    expect(await f.repository.get('env-run')).toMatchObject({ status: 'waiting' });

    f.green(); green = true;
    for (let i = 0; i < 100 && f.counts().resumes === 0; i++) await sleep(100);
    expect(f.counts()).toEqual({ executions: 1, resumes: 1, seenCalls: ['env-call'], seenRuns: ['env-run'] });
    expect(await f.repository.get('env-run')).toMatchObject({ status: 'completed' });
    expect(f.messages().filter((message) => message.role === 'user')).toHaveLength(1);
  }, 30_000);

  it('a repeated domain load does not arm a second loop or extend the window', async () => {
    const f = await restartedHarness();
    f.wire(async () => 'red');
    smMocks.restoreSession.mockResolvedValue({ id: 'env-session', title: 'Environment fixture', workingDirectory: workspace, createdAt: 1, updatedAt: 1, messages: f.messages() });
    const load = installDomainSessionLoad();
    await load(undefined, { action: 'load', payload: { sessionId: 'env-session' } });
    await load(undefined, { action: 'load', payload: { sessionId: 'env-session' } });
    expect(armedCalls()).toHaveLength(1);
    await sleep(3_200); // several poll intervals with a red probe
    expect(f.counts()).toMatchObject({ executions: 0, resumes: 0 });
    expect(armedCalls()).toHaveLength(1);
  }, 30_000);
});
