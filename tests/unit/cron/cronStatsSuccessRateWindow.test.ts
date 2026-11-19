// N-FIX-CRON-STATS-SUCCESS-RATE-ZERO-CACHE：getStats 的执行计数/成功率必须读 DB 权威窗
// （loadRecentCronExecutions，与「运行记录」tab 同源同 50 条上限），不是 this.executions——
// 重启后内存映射是空的，顶部「成功率」贴片会显示 0%。约束：绝不把历史写回 this.executions
// （连败自动停机只看本进程推进过的尾部，见 mergeCronExecutionWindow 注释）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { CronJobExecution } from '../../../src/shared/contract/cron';

const databaseState = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => databaseState.db }),
}));

import { CronService } from '../../../src/host/cron/cronService';
import { saveCronExecution, saveCronJob } from '../../../src/host/cron/cronPersistence';

const NOW = Date.UTC(2026, 10, 19, 8, 0, 0);
const DAY = 86_400_000;

function localJob(): Parameters<typeof saveCronJob>[0] {
  return {
    id: 'job-stats',
    name: 'morning digest',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'days' },
    action: { type: 'role-wake', roleId: 'role-a' },
    runsOn: 'local',
    enabled: false,
    maxRetries: 0,
    retryDelay: 5_000,
    timeout: 60_000,
    createdAt: NOW - 5 * DAY,
    updatedAt: NOW,
  };
}

function execution(id: string, status: CronJobExecution['status'], scheduledAt: number): CronJobExecution {
  return {
    id,
    jobId: 'job-stats',
    runsOn: 'local',
    status,
    scheduledAt,
    startedAt: scheduledAt,
    completedAt: scheduledAt + 1_000,
    duration: 1_000,
    retryAttempt: 0,
    ...(status === 'failed' ? { error: 'model unavailable' } : {}),
  };
}

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      schedule_type TEXT NOT NULL,
      schedule TEXT NOT NULL,
      action TEXT NOT NULL,
      runs_on TEXT NOT NULL,
      max_run_budget REAL,
      max_runs INTEGER,
      run_count INTEGER NOT NULL DEFAULT 0,
      min_interval_seconds INTEGER NOT NULL DEFAULT 60,
      result_channel TEXT,
      cloud_job_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_retries INTEGER,
      retry_delay INTEGER,
      timeout INTEGER,
      tags TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE cron_executions (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      duration INTEGER,
      result TEXT,
      error TEXT,
      retry_attempt INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER,
      trigger_json TEXT,
      cost_usd REAL,
      push_note TEXT
    );
  `);
}

function inMemoryMap(service: CronService): Map<string, CronJobExecution[]> {
  return (service as unknown as { executions: Map<string, CronJobExecution[]> }).executions;
}

describe('getStats 执行统计读 DB 权威窗（N-FIX-CRON-STATS-SUCCESS-RATE-ZERO-CACHE）', () => {
  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    databaseState.db = db;
  });

  afterEach(() => {
    databaseState.db?.close();
    databaseState.db = null;
  });

  it('重启后内存为空：库里 2 completed + 1 failed → 2 / 1 / ~67%', async () => {
    await saveCronJob(localJob());
    await saveCronExecution(execution('s1', 'completed', NOW));
    await saveCronExecution(execution('s2', 'completed', NOW - DAY));
    await saveCronExecution(execution('s3', 'failed', NOW - 2 * DAY));

    const service = new CronService();
    const stats = service.getStats();
    expect(stats.totalExecutions).toBe(3);
    expect(stats.successfulExecutions).toBe(2);
    expect(stats.failedExecutions).toBe(1);
    expect(stats.successRate).toBeCloseTo(66.67, 1);
    expect(stats.jobsByStatus.completed).toBe(2);
    expect(stats.jobsByStatus.failed).toBe(1);
  });

  it('库里没有执行记录 → 成功率 0（不是 NaN/undefined）', async () => {
    await saveCronJob(localJob());

    const service = new CronService();
    const stats = service.getStats();
    expect(stats.totalExecutions).toBe(0);
    expect(stats.successfulExecutions).toBe(0);
    expect(stats.failedExecutions).toBe(0);
    expect(stats.successRate).toBe(0);
  });

  it('历史读取不把旧行灌进内存：getJobExecutions(20) 后 this.executions 仍只有 limit=1 那条', async () => {
    await saveCronJob(localJob());
    await saveCronExecution(execution('s1', 'completed', NOW));
    await saveCronExecution(execution('s2', 'completed', NOW - DAY));
    await saveCronExecution(execution('s3', 'failed', NOW - 2 * DAY));

    const service = new CronService();
    service.getJobExecutions('job-stats', 1); // 任务列表的 limit=1，空缓存会写回该窗口
    service.getJobExecutions('job-stats', 20); // 角色页的历史窗口，不得灌进内存尾部
    expect(inMemoryMap(service).get('job-stats')).toHaveLength(1);
    // 统计与内存脱钩：内存 1 条，DB 窗口 3 条，成功率仍按 DB 算。
    expect(service.getStats().totalExecutions).toBe(3);
  });
});
