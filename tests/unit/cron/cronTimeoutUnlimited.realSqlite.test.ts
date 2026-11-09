import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const state = vi.hoisted(() => ({ db: null as BetterSqlite3.Database | null }));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => state.db }),
}));
vi.mock('../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer: vi.fn(),
  ipcHost: { handle: vi.fn() },
}));
vi.mock('../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({ ui: { language: 'zh' } }),
  }),
}));
vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    recordCreated: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    getBySourceRef: vi.fn(() => null),
    upsert: vi.fn(() => undefined),
  }),
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyTaskComplete: vi.fn(), notifyNeedsInput: vi.fn() },
}));
import { CronService } from '../../../src/host/cron/cronService';
import { normalizeCronJobRow } from '../../../src/host/cron/cronNormalizers';
import { buildCronJobInput, buildDraftFromJob } from '../../../src/renderer/components/features/cron/types';
const SCHEMA = `
  CREATE TABLE cron_jobs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
    schedule_type TEXT NOT NULL, schedule TEXT NOT NULL, action TEXT NOT NULL,
    runs_on TEXT NOT NULL DEFAULT 'local', max_run_budget REAL, max_runs INTEGER,
    run_count INTEGER NOT NULL DEFAULT 0, min_interval_seconds INTEGER NOT NULL DEFAULT 60,
    result_channel TEXT, cloud_job_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    max_retries INTEGER DEFAULT 0, retry_delay INTEGER DEFAULT 5000, timeout INTEGER DEFAULT 60000,
    tags TEXT, metadata TEXT DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE cron_executions (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, duration INTEGER,
    result TEXT, error TEXT, retry_attempt INTEGER NOT NULL DEFAULT 0, exit_code INTEGER,
    trigger_json TEXT, cost_usd REAL,
    FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
  );
`;

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cron-early-session-')));
  state.db = new Database(path.join(dir, 'cron.db'));
  state.db.pragma('foreign_keys = ON');
  state.db.exec(SCHEMA);
});
afterEach(() => {
  state.db?.close();
  state.db = null;
  rmSync(dir, { recursive: true, force: true });
});


const services: CronService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.shutdown(); });
function service() { const instance = new CronService(); services.push(instance); return instance; }
function input() {
  return {
    name: 'Unlimited execution', scheduleType: 'cron' as const,
    schedule: { type: 'cron' as const, expression: '37 23 * * *' },
    action: { type: 'agent' as const, agentType: 'default' as const, prompt: "Reply only 'received', no tools" },
    enabled: false,
  };
}
function read(id: string) {
  const row = state.db!.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id);
  const proof = state.db!.prepare('SELECT timeout, max_run_budget, max_runs FROM cron_jobs WHERE id = ?').get(id);
  console.log(`[sqlite timeout,max_run_budget,max_runs] ${JSON.stringify(proof)}`);
  const job = normalizeCronJobRow(row)!;
  expect(job).not.toBeNull();
  return { job, row: row as { timeout: number | null } };
}
describe('unlimited timeout real SQLite round trip', () => {
  it('⑤ create and update persist NULL for unset timeout', async () => {
    const host = service();
    const created = await host.createJob(input());
    expect(read(created.id).row.timeout).toBeNull();
    expect(read(created.id).job.timeout).toBeUndefined();
    await host.updateJob(created.id, { maxRunBudget: 0.01, maxRuns: 2 });
    expect(read(created.id).row.timeout).toBeNull();
    expect(read(created.id).job.timeout).toBeUndefined();
  });
  it('①② blank reopened draft stays unlimited after budget/max-runs only save', async () => {
    const host = service();
    const created = await host.createJob(input());
    const draft = buildDraftFromJob(read(created.id).job);
    expect(draft.timeout).toBe('');
    draft.maxRunBudget = '0.01'; draft.maxRuns = '2';
    await host.updateJob(created.id, JSON.parse(JSON.stringify(buildCronJobInput(draft))));
    const reopened = read(created.id);
    expect(reopened.row.timeout).toBeNull();
    expect(buildDraftFromJob(reopened.job).timeout).toBe('');
    expect(reopened.job).toMatchObject({ maxRunBudget: 0.01, maxRuns: 2 });
  });
  it('③ explicit five minutes survives save and reopen as 300000', async () => {
    const host = service();
    const created = await host.createJob({ ...input(), timeout: 300_000 });
    const payload = buildCronJobInput(buildDraftFromJob(read(created.id).job));
    await host.updateJob(created.id, JSON.parse(JSON.stringify(payload)));
    expect(read(created.id).row.timeout).toBe(300_000);
    expect(buildDraftFromJob(read(created.id).job).timeout).toBe('300000');
  });
  it('④ JSON clear payload carries null and update persists NULL', async () => {
    const host = service();
    const created = await host.createJob({ ...input(), timeout: 300_000 });
    const draft = buildDraftFromJob(read(created.id).job); draft.timeout = '';
    const payload = JSON.parse(JSON.stringify(buildCronJobInput(draft)));
    expect(payload.timeout).toBeNull();
    const updated = await host.updateJob(created.id, payload);
    expect(updated?.timeout).toBeUndefined();
    expect(read(created.id).row.timeout).toBeNull();
    expect(buildDraftFromJob(read(created.id).job).timeout).toBe('');
  });
  it('⑤ legacy local 60000 is unset while cloud retains real limit', async () => {
    const created = await service().createJob(input());
    state.db!.prepare('UPDATE cron_jobs SET timeout = 60000 WHERE id = ?').run(created.id);
    expect(read(created.id).job.timeout).toBeUndefined();
    state.db!.prepare("UPDATE cron_jobs SET runs_on = 'cloud' WHERE id = ?").run(created.id);
    expect(read(created.id).job.timeout).toBe(60_000);
  });
  it.each([null, 0, -1, NaN, Infinity])('unset/invalid timeout %s persists NULL', async (timeout) => {
    const host = service();
    const created = await host.createJob({ ...input(), timeout });
    expect(created.timeout).toBeUndefined();
    expect(read(created.id).row.timeout).toBeNull();
    await host.updateJob(created.id, { timeout: 300_000 });
    const updated = await host.updateJob(created.id, { timeout });
    expect(updated?.timeout).toBeUndefined();
    expect(read(created.id).row.timeout).toBeNull();
  });
});
