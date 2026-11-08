import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const databaseState = vi.hoisted(() => ({ db: null as BetterSqlite3.Database | null }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => databaseState.db }),
}));

import { applySchema } from '../../../src/host/services/core/database/schema';
import type { CronExecutionTrigger, CronJobDefinition } from '../../../src/shared/contract/cron';
import type { CronMailReader } from '../../../src/host/cron/cronMailPoller';
import {
  CronEventTrigger,
  type CronEventChannelSource,
  type CronEventTriggerHost,
} from '../../../src/host/cron/cronEventTrigger';
import type { CronMailWatermarkStore } from '../../../src/host/cron/cronMailWatermarkStore';

const NOW = Date.UTC(2026, 10, 1, 8, 0, 0);
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const activeTriggers: CronEventTrigger[] = [];

type MailSummary = Awaited<ReturnType<CronMailReader['listMessages']>>[number];

interface CapturedRun {
  trigger: CronExecutionTrigger;
  payloadBlock: string;
}

function mailJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'mail-watermark-job',
    name: 'watch inbox',
    scheduleType: 'event',
    schedule: {
      type: 'event',
      source: 'connector',
      connector: 'mail',
      accountId: 'account-a',
      mailbox: 'INBOX',
      eventName: 'message',
      pollIntervalSec: 30,
      batchWindowSec: 10,
      minRunIntervalSec: 30,
    },
    action: { type: 'agent', agentType: 'default', prompt: 'handle new mail' },
    runsOn: 'local',
    maxRunBudget: 1,
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function mailMessage(id: number): MailSummary {
  return {
    id,
    subject: `subject ${id}`,
    sender: 'sender@example.com',
    receivedAtMs: NOW,
    read: false,
  };
}

function freshDb(job: CronJobDefinition): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db, noopLogger);
  db.prepare(`
    INSERT INTO cron_jobs (id, name, schedule_type, schedule, action, runs_on, max_run_budget, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id,
    job.name,
    job.scheduleType,
    JSON.stringify(job.schedule),
    JSON.stringify(job.action),
    job.runsOn,
    job.maxRunBudget,
    job.enabled ? 1 : 0,
    job.createdAt,
    job.updatedAt,
  );
  return db;
}

function createMailHarness(
  jobs: CronJobDefinition[],
  reader: Partial<CronMailReader>,
  watermarkStore?: CronMailWatermarkStore,
) {
  const runs: CapturedRun[] = [];
  const host: CronEventTriggerHost = {
    getJobDefinitions: () => jobs,
    isJobInFlight: () => false,
    executeEventJob: async (_definition, trigger, payloadBlock) => {
      runs.push({ trigger, payloadBlock });
    },
  };
  const mailReader: CronMailReader = {
    listMessages: reader.listMessages ?? (async () => []),
    readMessage: reader.readMessage ?? (async () => ''),
  };
  const trigger = new CronEventTrigger({
    host,
    channelSource: new EventEmitter() as unknown as CronEventChannelSource,
    mailReader,
    now: () => Date.now(),
    ...(watermarkStore ? { watermarkStore } : {}),
  });
  trigger.start();
  activeTriggers.push(trigger);
  return { trigger, runs, mailReader };
}

function watermarkRow(db: BetterSqlite3.Database, jobId = 'mail-watermark-job') {
  return db.prepare('SELECT job_id, binding, seen_keys, updated_at FROM cron_mail_watermarks WHERE job_id = ?').get(jobId) as {
    job_id: string;
    binding: string;
    seen_keys: string;
    updated_at: number;
  } | undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  for (const trigger of activeTriggers.splice(0)) trigger.dispose();
  databaseState.db?.close();
  databaseState.db = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('CronEventTrigger mail watermark restart persistence', () => {
  it('① persists a watermark and delivers only mail that arrived during a restart', async () => {
    const job = mailJob();
    const jobs = [job];
    const db = freshDb(job);
    databaseState.db = db;
    const messages = [mailMessage(1)];
    const listMessages = vi.fn(async () => [...messages]);
    const first = createMailHarness(jobs, { listMessages });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(first.runs).toHaveLength(0);
    expect(watermarkRow(db)).toMatchObject({ job_id: job.id, binding: 'account-a|INBOX', updated_at: NOW + 5_000 });
    expect(JSON.parse(watermarkRow(db)?.seen_keys ?? '[]')).toEqual(['account-a|INBOX|1']);
    first.trigger.dispose();

    messages.push(mailMessage(2));
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      process.stderr.write(`${args.join(' ')}\n`);
    });
    const restarted = createMailHarness(jobs, { listMessages });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(restarted.runs).toHaveLength(1);
    expect(restarted.runs[0].trigger.eventIds).toEqual(['account-a|INBOX|2']);
    expect(restarted.runs[0].payloadBlock).toContain('subject 2');
    expect(restarted.runs[0].payloadBlock).not.toContain('subject 1');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('cause: no-watermark'));
  });

  it('② seeds first bind and re-bind without triggering, with distinguishable warnings', async () => {
    const job = mailJob();
    const jobs = [job];
    const db = freshDb(job);
    databaseState.db = db;
    const messages = new Map<string, MailSummary[]>([
      ['account-a', [mailMessage(1)]],
      ['account-b', [mailMessage(2)]],
    ]);
    const listMessages = vi.fn(async (account: string) => [...(messages.get(account) ?? [])]);
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      process.stderr.write(`${args.join(' ')}\n`);
    });
    const harness = createMailHarness(jobs, { listMessages });

    await vi.advanceTimersByTimeAsync(5_000);
    jobs[0] = mailJob({ schedule: { ...job.schedule, accountId: 'account-b' } });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.runs).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('job mail-watermark-job (cause: no-watermark)'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('job mail-watermark-job (cause: binding-changed)'));
  });

  it('③ uses no-watermark for a fresh restart and contains an unavailable store failure', async () => {
    const job = mailJob();
    const jobs = [job];
    const db = freshDb(job);
    databaseState.db = db;
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      process.stderr.write(`${args.join(' ')}\n`);
    });
    const listMessages = vi.fn(async () => [] as MailSummary[]);
    const first = createMailHarness(jobs, { listMessages });
    first.trigger.dispose();
    expect(watermarkRow(db)).toBeUndefined();

    const restarted = createMailHarness(jobs, { listMessages });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(restarted.runs).toHaveLength(0);
    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('job mail-watermark-job (cause: no-watermark)'));

    restarted.trigger.dispose();
    const throwingStore: CronMailWatermarkStore = {
      load: () => { throw new Error('temporary read failure'); },
      save: () => 'ok',
    };
    const unavailable = createMailHarness(jobs, { listMessages }, throwingStore);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(unavailable.runs).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('job mail-watermark-job (cause: store-unavailable)'));
    const callsAfterUnavailable = listMessages.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listMessages.mock.calls.length).toBe(callsAfterUnavailable + 1);
  });

  it('④ leaves a failed restart poll unadvanced so the next successful poll delivers the mail', async () => {
    const job = mailJob();
    const jobs = [job];
    const db = freshDb(job);
    databaseState.db = db;
    const messages = [mailMessage(1)];
    const first = createMailHarness(jobs, { listMessages: async () => [...messages] });
    await vi.advanceTimersByTimeAsync(5_000);
    first.trigger.dispose();

    messages.push(mailMessage(2));
    let failed = true;
    const listMessages = vi.fn(async () => {
      if (failed) {
        failed = false;
        throw new Error('read failed');
      }
      return [...messages];
    });
    const error = vi.spyOn(console, 'error').mockImplementation((...args) => {
      process.stderr.write(`${args.join(' ')}\n`);
    });
    const restarted = createMailHarness(jobs, { listMessages });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(restarted.runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(restarted.runs).toHaveLength(1);
    expect(restarted.runs[0].trigger.eventIds).toEqual(['account-a|INBOX|2']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('(cause: read-error)'));
  });
});
