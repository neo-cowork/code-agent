import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../../src/host/platform';
import { createApp } from '../../../src/web/app';
import { SERVER_AUTH_TOKEN } from '../../../src/web/middleware/auth';
import { getDatabase } from '../../../src/host/services/core/databaseService';
import { getCronService, initCronService } from '../../../src/host/cron/cronService';
import { registerMemoryConsolidationJob } from '../../../src/web/webStartupMemoryJobs';
import { getApplicationRunRegistry, resetApplicationRunRegistryForTests } from '../../../src/host/app/applicationRunRegistry';
import { daemonStayReasons, type DaemonIdleSnapshot } from '../../../src/host/services/daemon/daemonIdle';
import { BUILTIN_MAINTENANCE_JOB_TAGS } from '../../../src/shared/constants/memory';

vi.unmock('better-sqlite3');
vi.hoisted(() => { vi.stubEnv('CODE_AGENT_WEB_MODE', 'true'); });

describe('armed schedules through createApp and its daemon idle registration', () => {
  let dataDir: string;
  let server: http.Server;
  let url: string;
  let getSnapshot: () => DaemonIdleSnapshot;
  let shutdownApp: () => Promise<void>;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'armed-schedules-'));
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
    vi.spyOn(app, 'getPath').mockReturnValue(dataDir);
    await getDatabase().initialize();
    expect(existsSync(path.join(dataDir, 'code-agent.db'))).toBe(true);
    await initCronService();
    const webApp = createApp({
      handlers: new Map(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      runRegistry: getApplicationRunRegistry(),
      pendingLocalToolCalls: new Map(),
      pendingDevPermissions: new Map(),
      resolveCodeAgentDataDir: () => dataDir,
      getAppVersion: () => '0.0.0-test',
      getBuildInfo: () => null,
      getDurableRunRollout: () => ({
        policy: { mode: 'legacy', configuredValue: null, valid: true, durableActivation: false, durableReadPreference: false },
        ready: false,
      }),
      getDurableRunReadService: () => undefined,
      internalFeatures: {
        runtime: { isLoaded: () => false, loadedHash: () => undefined },
        registry: { getPlugin: () => undefined },
        pluginsDir: path.join(dataDir, 'plugins'),
      },
      registerDaemonIdleSnapshot: (getter) => { getSnapshot = getter; },
      registerCompanionShutdown: (stop) => { shutdownApp = stop; },
    });
    server = http.createServer(webApp);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/quit-guard`;
  });

  beforeEach(async () => {
    for (const job of getCronService().listJobs()) await getCronService().deleteJob(job.id);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await shutdownApp?.();
    await getCronService().shutdown();
    getDatabase().close();
    resetApplicationRunRegistryForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function expectCounts(expected: number) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${SERVER_AUTH_TOKEN}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activeRuns: 0, armedSchedules: expected, language: 'zh' });
    const snapshot = getSnapshot();
    expect(snapshot).toEqual({ runningRuns: false, pairedCompanion: false, awaitingApproval: false, armedSchedules: expected });
    expect(daemonStayReasons(snapshot, 'background')).toEqual(expected === 0 ? [] : ['armed-schedules']);
  }

  async function createJob(name: string, tags?: string[]) {
    return getCronService().createJob({
      name,
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: '0 0 9 * * 1-5' },
      action: { type: 'reminder', message: 'Send the weekly report' },
      enabled: true,
      tags,
    });
  }

  it('fresh startup keeps enabled Light Memory maintenance but counts zero', async () => {
    await registerMemoryConsolidationJob();
    expect(getCronService().listJobs({ enabled: true })).toEqual([
      expect.objectContaining({ name: '[Maintenance] Light Memory consolidation', tags: ['light-memory-consolidation'] }),
    ]);
    await expectCounts(0);
  });

  it.each(Object.values(BUILTIN_MAINTENANCE_JOB_TAGS))('excludes maintenance tag %s even after a rename and with other tags', async (tag) => {
    await createJob('Renamed background cleanup', ['unrelated', tag]);
    await expectCounts(0);
  });

  it('counts one user schedule alongside maintenance, then zero when disabled or deleted', async () => {
    await registerMemoryConsolidationJob();
    const userJob = await createJob('Weekday report reminder');
    await expectCounts(1);
    await getCronService().updateJob(userJob.id, { enabled: false });
    await expectCounts(0);
    await getCronService().updateJob(userJob.id, { enabled: true });
    await expectCounts(1);
    await getCronService().deleteJob(userJob.id);
    await expectCounts(0);
  });

  it.each(['unrelated', 'role-cadence', 'light-memory-consolidation-custom'])('still counts user tag %s, even with a maintenance-looking name', async (tag) => {
    await createJob('[Maintenance] My report reminder', [tag]);
    await expectCounts(1);
  });
});
