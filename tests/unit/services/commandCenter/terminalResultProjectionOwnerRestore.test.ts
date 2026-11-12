import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { DatabaseService } from '../../../../src/host/services/core/databaseService';
import { applySchema } from '../../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../../src/host/services/core/database/migrations';
import { SessionRepository } from '../../../../src/host/services/core/repositories/SessionRepository';
import { SessionCommandCenter, resetSessionCommandCenterForTest } from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';
import type { TaskManager } from '../../../../src/host/task/TaskManager';
import {
  BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS,
  BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS,
} from '../../../../src/shared/constants/sessionCommandCenter';

// N-FIX-BG-WAKE-SKIPPED-SESSION-INACCESSIBLE-AFTER-LOGIN-RESTORE-REDRAFT-FU1-FIX：
// 产线入口 SessionCommandCenter.settle（默认投影 + 默认 createForegroundWake）+ 真 SessionManager
// + 真 sqlite；只替换登录用户（可控）、TaskManager 外壳和 logger（捕获）。
// 关注点：投影在登录恢复窗口里失败时，唤醒不再被跳过、结果行经有界重试落回会话、
// 耗尽后有一句人话，且不会写出重复行。

const harness = vi.hoisted(() => ({
  db: null as unknown,
  user: null as { id: string } | null,
  callbacks: [] as Array<(user: { id: string } | null, status: string) => void>,
  log: [] as Array<{ level: string; message: string; details?: Record<string, unknown> }>,
  sendMessage: (async () => undefined) as (...args: unknown[]) => Promise<void>,
}));

vi.mock('../../../../src/host/services/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/host/services/core')>()),
  getDatabase: () => harness.db,
}));
vi.mock('../../../../src/host/services/core/databaseService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/host/services/core/databaseService')>()),
  getDatabase: () => harness.db,
}));
vi.mock('../../../../src/host/services/core/configService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/host/services/core/configService')>()),
  getConfigService: () => { throw new Error('config service unavailable in this test'); },
}));
vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({
    getCurrentUser: () => harness.user,
    addAuthChangeCallback: (callback: (user: { id: string } | null, status: string) => void) => {
      harness.callbacks.push(callback);
      return () => {
        const index = harness.callbacks.indexOf(callback);
        if (index > -1) harness.callbacks.splice(index, 1);
      };
    },
  }),
}));
vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  getSupabase: () => null,
  isSupabaseInitialized: () => false,
}));
vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/host/services/infra/logger')>();
  const make = (level: string) => (message: string, details?: Record<string, unknown>) => {
    harness.log.push({ level, message, details });
  };
  return {
    ...original,
    createLogger: () => ({ debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') }),
  };
});
vi.mock('../../../../src/host/task/TaskManager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/host/task/TaskManager')>();
  const orchestrator = {
    isProcessing: () => false,
    sendMessage: (...args: unknown[]) => harness.sendMessage(...args),
  };
  return {
    ...original,
    getTaskManager: () => ({
      getSessionState: () => ({ status: 'idle' }),
      getWaitingQueue: () => [],
      hasActivePrimaryRun: () => false,
      getOrCreateCurrentOrchestrator: () => orchestrator,
      setSessionContext: () => undefined,
      setWorkingDirectory: () => undefined,
      on: () => undefined,
      onRunIdle: () => undefined,
      emitAgentEventForSession: () => undefined,
      observeAgentEvents: () => () => undefined,
    }),
  };
});

import { getSessionManager } from '../../../../src/host/services/infra/sessionManager';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../../src/host/services/commandCenter/sessionTaskSlotLedger';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const SESSION = 'session-owned-by-u1';

/** startBackgroundTask 永不 settle：终态由测试显式 emit，模拟任务自然完成。 */
class ControllableTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockReturnValue(new Promise(() => undefined));
  interruptBackgroundTask = vi.fn().mockResolvedValue(true);
  cancelBackgroundTask = vi.fn().mockResolvedValue(true);
  observeAgentEvents(): () => void { return () => undefined; }
}

const logsOf = (level: string) => harness.log.filter((entry) => entry.level === level);
const fireAuth = (user: { id: string } | null) => {
  harness.user = user;
  for (const callback of [...harness.callbacks]) callback(user, user ? 'authenticated' : 'unauthenticated');
};

describe('settle 终态投影在登录恢复窗口里的收口', () => {
  let tmpDir: string;
  let previousDataDir: string | undefined;
  let coreDb: DatabaseService;
  let connection: Database.Database;

  async function spawnAndComplete(manager: ControllableTaskManager, center: SessionCommandCenter): Promise<string> {
    const spawned = await center.spawn({
      sessionId: SESSION,
      title: '周报',
      shortName: '周报',
      laneKey: 'lane-a',
      submissionKey: 'sub-a',
      prompt: 'do it',
      workspaceScope: createWorkspaceScope('p', [{ sourceId: 's', path: tmpDir, role: 'primary', access: 'read_write' }]),
    });
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');
    manager.emit('task_completed', { type: 'task_completed', sessionId: SESSION, data: { taskId: spawned.task.id, conclusion: '周报已写好' } });
    return spawned.task.id;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    harness.log.length = 0;
    harness.callbacks.length = 0;
    harness.user = null;
    harness.sendMessage = vi.fn(async () => {
      await getSessionManager().addMessageToSession(SESSION, {
        id: `wake-reply-${Math.random()}`, role: 'assistant', content: '周报已汇总并交付', timestamp: Date.now(),
      });
    });
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-projection-owner-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
    resetSessionCommandCenterForTest();
    resetSessionTaskConcurrencyPoolForTest();
    getSessionManager().clearCache();
    coreDb = new DatabaseService();
    connection = new Database(path.join(tmpDir, 'code-agent.db'));
    connection.pragma('journal_mode = WAL');
    applySchema(connection, logger as never);
    applySessionsMigrations(connection, logger as never);
    Object.assign(coreDb as unknown as Record<string, unknown>, {
      db: connection,
      sessionRepo: new SessionRepository(connection),
    });
    vi.spyOn(coreDb, 'logAuditEvent').mockImplementation(() => undefined);
    harness.db = coreDb;
    coreDb.createSessionWithId(SESSION, {
      title: '会话', userId: 'u1', modelConfig: { provider: 'zhipu', model: 'glm-5' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetSessionCommandCenterForTest();
    resetSessionTaskConcurrencyPoolForTest();
    harness.db = null;
    try { coreDb.close(); } catch { /* noop */ }
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function messageRows(): Array<{ id: string; role: string; content: string; metadata: unknown }> {
    const raw = connection.prepare('SELECT id, role, content, metadata FROM messages WHERE session_id = ?').all(SESSION) as Array<{
      id: string; role: string; content: string; metadata: string | null;
    }>;
    return raw.map((row) => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : undefined }));
  }

  it('投影失败不跳过唤醒：owner 恢复后恰好一条结果行（人话状态词）加一次汇报', async () => {
    const manager = new ControllableTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {});
    const taskId = await spawnAndComplete(manager, center);

    await vi.waitFor(() => expect(logsOf('warn').some((entry) => entry.details?.reason === 'terminal_projection_failed')).toBe(true));
    // 唤醒没有被投影失败连坐跳过：它自己的 owner 等待 warn 已出现
    expect(logsOf('warn').some((entry) => entry.details?.reason === 'session_not_accessible_for_current_owner')).toBe(true);
    // 重试挂起中：running 标记还在（重试窗口内宿主再崩，下次启动还能补中断行）
    const markerFile = path.join(tmpDir, 'session-command-running', `${encodeURIComponent(taskId)}.json`);
    expect(fs.existsSync(markerFile)).toBe(true);
    expect(messageRows()).toHaveLength(0);

    fireAuth({ id: 'u1' });
    await vi.waitFor(() => expect(messageRows().length).toBe(2));

    const rows = messageRows();
    const resultRow = rows.find((row) => row.role === 'system');
    expect(resultRow?.id).toBe(`session-task-result-${taskId}`);
    expect(resultRow?.content).toBe('[任务结果] 周报｜已完成｜周报已写好');
    expect((resultRow?.metadata as { backgroundTaskResult?: { status?: string } }).backgroundTaskResult?.status).toBe('completed');
    const reply = rows.find((row) => row.role === 'assistant');
    expect(reply?.content).toBe('周报已汇总并交付');
    await vi.waitFor(() => expect(fs.existsSync(markerFile)).toBe(false));

    // 定时器重试不会再写第二行（id 幂等 + 重试已落定）
    await vi.advanceTimersByTimeAsync(BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS * (BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS + 2));
    expect(messageRows()).toHaveLength(2);
    expect(logsOf('warn').some((entry) => entry.details?.reason === 'terminal_projection_not_accessible_retries_exhausted')).toBe(false);
    expect(logsOf('warn').some((entry) => entry.message === 'Background wake failure note not recorded')).toBe(false);
  });

  it('重试耗尽：留有区别度的 warn；owner 恢复后恰好一句人话，不写结果行', async () => {
    const manager = new ControllableTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {});
    const taskId = await spawnAndComplete(manager, center);

    await vi.advanceTimersByTimeAsync(BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS * (BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS + 2));

    // 耗尽只留一条 exhaustion warn；人话句当场写不进（会话仍不可读）→ 也有 warn
    const exhausted = logsOf('warn').filter((entry) => entry.details?.reason === 'terminal_projection_not_accessible_retries_exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].details).toMatchObject({ sessionId: SESSION, taskId, ownerSignedIn: false });
    expect(logsOf('warn').some((entry) => entry.message === 'Background wake failure note not recorded')).toBe(true);
    expect(messageRows()).toHaveLength(0);
    // 耗尽不清标记：终态快照留在标记里，下次启动的重启恢复还能按真实结局补投结果
    const markerFile = path.join(tmpDir, 'session-command-running', `${encodeURIComponent(taskId)}.json`);
    expect(fs.existsSync(markerFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(markerFile, 'utf8')).terminal).toMatchObject({ status: 'completed' });

    // owner 恢复：耗尽分支挂的一次性补写落地，恰好一句人话
    fireAuth({ id: 'u1' });
    await vi.waitFor(() => expect(messageRows().length).toBe(1));
    const [note] = messageRows();
    expect(note.role).toBe('system');
    expect(note.content).toContain('后台任务「周报」已结束');
    expect(note.content).toContain('自动汇报这一步没能完成');
    expect((note.metadata as { backgroundWakeFailed?: { taskId?: string } }).backgroundWakeFailed?.taskId).toBe(taskId);

    await vi.advanceTimersByTimeAsync(BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS * 2);
    expect(messageRows()).toHaveLength(1);
  });

  it('非可达性失败不进重试：只留 terminal_projection_failed 的 warn，标记照清', async () => {
    const manager = new ControllableTaskManager();
    const projection = vi.fn().mockRejectedValue(new Error('sqlite: disk I/O error'));
    const wake = vi.fn().mockResolvedValue(undefined);
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: projection,
      wakeForegroundBrain: wake,
    });
    const taskId = await spawnAndComplete(manager, center);

    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(logsOf('warn').filter((entry) => entry.details?.reason === 'terminal_projection_failed')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS * (BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS + 2));
    expect(projection).toHaveBeenCalledTimes(1);
    expect(logsOf('warn').some((entry) => entry.details?.reason === 'terminal_projection_not_accessible_for_current_owner')).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'session-command-running', `${encodeURIComponent(taskId)}.json`))).toBe(false);
  });
});
