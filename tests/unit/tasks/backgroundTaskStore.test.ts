import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');

import Database from 'better-sqlite3';
import { BackgroundTaskLedger } from '../../../src/host/task/backgroundTaskLedger';
import { SqliteBackgroundTaskStore } from '../../../src/host/task/backgroundTaskStore';

describe('SqliteBackgroundTaskStore', () => {
  let tempDir: string | null = null;
  let db: import('better-sqlite3').Database | null = null;

  afterEach(async () => {
    db?.close();
    db = null;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  async function createDbPath(): Promise<string> {
    tempDir = await mkdtemp(path.join(tmpdir(), 'code-agent-background-task-store-'));
    return path.join(tempDir, 'tasks.db');
  }

  it('reads shell and PTY terminal tasks back from a file-backed SQLite adapter', async () => {
    const dbPath = await createDbPath();
    db = new Database(dbPath);

    const store = new SqliteBackgroundTaskStore(db);
    const ledger = new BackgroundTaskLedger({ store });
    ledger.upsertTask({
      id: 'shell:shell-1',
      kind: 'shell',
      sessionId: 'session-shell',
      source: 'shell',
      title: 'npm test',
      status: 'completed',
      createdAt: 100,
      updatedAt: 200,
      startedAt: 100,
      completedAt: 200,
      durationMs: 100,
    });
    ledger.addOutputRef({
      id: 'shell:shell-1:log',
      taskId: 'shell:shell-1',
      type: 'log',
      path: '/tmp/shell-1.log',
      createdAt: 100,
    });
    ledger.upsertTask({
      id: 'pty:pty-1',
      kind: 'pty',
      sessionId: 'session-pty',
      source: 'pty',
      title: 'bash -lc npm run dev',
      status: 'failed',
      createdAt: 300,
      updatedAt: 450,
      startedAt: 300,
      completedAt: 450,
      durationMs: 150,
      failure: {
        message: 'Process exited with code 1',
        exitCode: 1,
        category: 'command_failed',
      },
    });
    db.close();
    db = null;

    db = new Database(dbPath);
    const restartedStore = new SqliteBackgroundTaskStore(db);
    const restartedLedger = new BackgroundTaskLedger({ store: restartedStore });

    expect(restartedStore.listBySession('session-shell').map((task) => task.id)).toEqual(['shell:shell-1']);
    expect(restartedLedger.getTask('shell:shell-1')).toMatchObject({
      id: 'shell:shell-1',
      kind: 'shell',
      source: 'shell',
      sessionId: 'session-shell',
      status: 'completed',
      completedAt: 200,
      outputRefs: [
        expect.objectContaining({
          id: 'shell:shell-1:log',
          path: '/tmp/shell-1.log',
        }),
      ],
    });
    expect(restartedLedger.listTasks({ source: 'pty' })).toEqual([
      expect.objectContaining({
        id: 'pty:pty-1',
        kind: 'pty',
        source: 'pty',
        status: 'failed',
        failure: expect.objectContaining({ exitCode: 1 }),
      }),
    ]);
  });

  it('projects terminal cron executions as background tasks without running cron', async () => {
    const dbPath = await createDbPath();
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule TEXT NOT NULL,
        action TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
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
        exit_code INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO cron_jobs
        (id, name, schedule_type, schedule, action, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'job-1',
      'Nightly build',
      'cron',
      JSON.stringify({ type: 'cron', expression: '0 2 * * *' }),
      JSON.stringify({ type: 'shell', command: 'npm run build', cwd: '/repo' }),
      1,
      10,
      20,
    );
    db.prepare(`
      INSERT INTO cron_executions
        (id, job_id, session_id, status, scheduled_at, started_at, completed_at, duration, result, error, retry_attempt, exit_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'exec-1',
      'job-1',
      'session-cron',
      'failed',
      1_000,
      1_100,
      1_900,
      800,
      JSON.stringify({ stdout: '', stderr: 'boom' }),
      'boom',
      0,
      1,
    );

    const ledger = new BackgroundTaskLedger({
      store: new SqliteBackgroundTaskStore(db),
    });

    expect(ledger.getTask('cron:exec-1')).toMatchObject({
      id: 'cron:exec-1',
      kind: 'cron',
      source: 'cron',
      title: 'Nightly build',
      sessionId: 'session-cron',
      command: 'npm run build',
      cwd: '/repo',
      status: 'failed',
      completedAt: 1_900,
      failure: {
        message: 'boom',
        exitCode: 1,
        category: 'cron_failed',
      },
      metadata: expect.objectContaining({
        jobId: 'job-1',
        executionId: 'exec-1',
        actionType: 'shell',
      }),
    });
    expect(ledger.listTasks({ source: 'cron' }).map((task) => task.id)).toEqual(['cron:exec-1']);
  });

  it('drains queued notifications from a file-backed SQLite adapter after restart', async () => {
    const dbPath = await createDbPath();
    db = new Database(dbPath);

    const ledger = new BackgroundTaskLedger({
      store: new SqliteBackgroundTaskStore(db),
      now: () => 500,
    });
    ledger.upsertTask({
      id: 'shell:notice-1',
      kind: 'shell',
      sessionId: 'session-notice',
      source: 'shell',
      title: 'npm run build',
      status: 'running',
      createdAt: 100,
      updatedAt: 150,
    });
    ledger.queueNotification({
      id: 'notification-1',
      taskId: 'shell:notice-1',
      sessionId: 'session-notice',
      type: 'task_completed',
      message: 'Build finished',
      createdAt: 200,
    });
    db.close();
    db = null;

    db = new Database(dbPath);
    const restartedLedger = new BackgroundTaskLedger({
      store: new SqliteBackgroundTaskStore(db),
      now: () => 600,
    });

    expect(restartedLedger.drainNotifications('session-notice')).toEqual([
      expect.objectContaining({
        id: 'notification-1',
        taskId: 'shell:notice-1',
        sessionId: 'session-notice',
        type: 'task_completed',
        message: 'Build finished',
        deliveredAt: 600,
      }),
    ]);
    expect(restartedLedger.drainNotifications('session-notice')).toEqual([]);
  });
  // C3（2026-08-05）：终态台账原本两条列表查询都无 LIMIT 无清理，全表扫描随使用
  // 单调增长，而 renderer 每 3s 就读一次；swarm 并发把写入放大后成为读失败诱因。
  it('列表只返回最近 N 条终态，且启动时裁掉超出保留窗口的老行', async () => {
    const dbPath = await createDbPath();
    db = new Database(dbPath);
    const store = new SqliteBackgroundTaskStore(db);
    const ledger = new BackgroundTaskLedger({ store });

    const TOTAL = 620;
    for (let i = 0; i < TOTAL; i += 1) {
      ledger.upsertTask({
        id: `shell:bulk-${i}`,
        kind: 'shell',
        sessionId: 'session-bulk',
        source: 'shell',
        title: `job ${i}`,
        status: 'completed',
        createdAt: i,
        updatedAt: i,
        startedAt: i,
        completedAt: i,
        durationMs: 1,
      });
    }

    const rowsBeforeRestart = (db.prepare(
      'SELECT COUNT(*) AS n FROM background_task_terminal_tasks',
    ).get() as { n: number }).n;
    expect(rowsBeforeRestart).toBe(TOTAL);

    // 列表查询封顶：不管表里多少行，读回来的都是最近的那批
    expect(store.loadTerminalTasks().length).toBe(200);
    expect(store.loadTerminalTasks()[0]?.id).toBe(`shell:bulk-${TOTAL - 1}`);

    // 重开（= 下次启动）时裁掉保留窗口以外的老行
    db.close();
    db = new Database(dbPath);
    new SqliteBackgroundTaskStore(db);
    const rowsAfterRestart = (db.prepare(
      'SELECT COUNT(*) AS n FROM background_task_terminal_tasks',
    ).get() as { n: number }).n;
    expect(rowsAfterRestart).toBe(500);

    // 裁掉的是最老的，最近的必须还在
    const survived = db.prepare(
      'SELECT id FROM background_task_terminal_tasks WHERE id = ?',
    ).get(`shell:bulk-${TOTAL - 1}`) as { id?: string } | undefined;
    expect(survived?.id).toBe(`shell:bulk-${TOTAL - 1}`);
    const pruned = db.prepare(
      'SELECT id FROM background_task_terminal_tasks WHERE id = ?',
    ).get('shell:bulk-0') as { id?: string } | undefined;
    expect(pruned).toBeUndefined();
  });
  describe('dismissTerminalTasks (clear finished)', () => {
    const shellTask = (id: string, sessionId: string, status: 'completed' | 'cancelled' | 'running', updatedAt: number) => ({
      id,
      kind: 'shell',
      sessionId,
      source: 'shell',
      title: id,
      status,
      createdAt: 100,
      updatedAt,
      ...(status === 'running' ? {} : { completedAt: updatedAt }),
    });

    function seedCron(database: import('better-sqlite3').Database): void {
      database.exec(`
        CREATE TABLE IF NOT EXISTS cron_executions (
          id TEXT PRIMARY KEY, job_id TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL,
          scheduled_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, duration INTEGER,
          result TEXT, error TEXT, retry_attempt INTEGER NOT NULL DEFAULT 0, exit_code INTEGER
        );
      `);
      database.prepare(`
        INSERT OR REPLACE INTO cron_executions (id, job_id, session_id, status, scheduled_at, completed_at, retry_attempt)
        VALUES ('exec-d', 'job-d', 'session-d', 'completed', 1000, 1900, 0)
      `).run();
    }

    it('restart: cleared ended rows (incl. cron-derived) stay gone, other sessions and running tasks untouched', async () => {
      const dbPath = await createDbPath();
      db = new Database(dbPath);
      seedCron(db);
      const ledger = new BackgroundTaskLedger({ store: new SqliteBackgroundTaskStore(db) });
      ledger.upsertTask(shellTask('shell:done', 'session-d', 'completed', 200));
      ledger.upsertTask(shellTask('shell:stopped', 'session-d', 'cancelled', 300));
      ledger.upsertTask(shellTask('shell:other', 'session-other', 'completed', 250));
      ledger.upsertTask(shellTask('shell:live', 'session-d', 'running', 400));
      expect(ledger.listTasks({ sessionId: 'session-d' }).map((t) => t.id).sort())
        .toEqual(['cron:exec-d', 'shell:done', 'shell:live', 'shell:stopped']);

      const dismissed = ledger.dismissTerminalTasks('session-d', 5_000);
      expect(dismissed.sort()).toEqual(['cron:exec-d', 'shell:done', 'shell:stopped']);
      expect(ledger.listTasks({ sessionId: 'session-d' }).map((t) => t.id)).toEqual(['shell:live']);
      expect(ledger.getTask('shell:done')).toBeNull();

      db.close();
      db = new Database(dbPath);
      const restartedStore = new SqliteBackgroundTaskStore(db);
      const restarted = new BackgroundTaskLedger({ store: restartedStore });
      expect(restartedStore.listBySession('session-d').map((t) => t.id)).toEqual([]);
      expect(restarted.listTasks({ sessionId: 'session-d' })).toEqual([]);
      expect(restarted.listTasks({ sessionId: 'session-other' }).map((t) => t.id)).toEqual(['shell:other']);
      // 台账行本身没被删，只是被标记隐藏
      const row = db.prepare('SELECT id FROM background_task_terminal_tasks WHERE id = ?').get('shell:done');
      expect(row).toBeDefined();
    });

    it('restart: rows that were not cleared come back', async () => {
      const dbPath = await createDbPath();
      db = new Database(dbPath);
      const ledger = new BackgroundTaskLedger({ store: new SqliteBackgroundTaskStore(db) });
      ledger.upsertTask(shellTask('shell:keep', 'session-keep', 'completed', 200));
      db.close();
      db = new Database(dbPath);
      const restarted = new BackgroundTaskLedger({ store: new SqliteBackgroundTaskStore(db) });
      expect(restarted.listTasks({ sessionId: 'session-keep' }).map((t) => t.id)).toEqual(['shell:keep']);
    });
  });
});
