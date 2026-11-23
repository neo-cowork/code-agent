import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as esbuild from 'esbuild';
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
import { addAndPersistMessage } from '../../../../src/host/agent/runtime/contextAssembly/systemContextStack';
import type { ContextAssemblyCtx } from '../../../../src/host/agent/runtime/contextAssembly/shared';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';
import type { AuthStatus, AuthUser, Message } from '../../../../src/shared/contract';
import type { TaskManager } from '../../../../src/host/task/TaskManager';
import {
  BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS,
  BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS,
} from '../../../../src/shared/constants/sessionCommandCenter';

// N-FIX-BG-WAKE-SKIPPED-SESSION-INACCESSIBLE-AFTER-LOGIN-RESTORE-REST1-FU1-FU1：
// 与 terminalResultProjectionOwnerRestore.test.ts 同一副骨架（真 SessionCommandCenter +
// 真 SessionManager + 真 sqlite + TaskManager 外壳/logger 捕获），但登录态不再是手搓 mock——
// 用真 AuthService（种入真实 currentUser）+ 真 devFaultLoader + 真编译产物
// dev-fault-inject.cjs 的 auth_user_blank:<ms> 开关把 getCurrentUser() 短时读空再恢复。
// 空窗由 <dataDir>/dev-fault/auth_user_blank.start 文件触发，恢复只看窗口时钟。
// 登录恢复信号（addAuthChangeCallback）仍按产线真实注册，只把回调捕获下来由测试代发。

const harness = vi.hoisted(() => ({
  db: null as unknown,
  callbacks: [] as Array<(user: AuthUser | null, status: AuthStatus) => void>,
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
vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  ensureSupabaseInitialized: () => { throw new Error('supabase unavailable in this test'); },
  getSupabase: () => null,
  isSupabaseInitialized: () => false,
}));
vi.mock('../../../../src/host/services/cloudRun/cloudRunLedger', () => ({ bindCloudRunAccountSource: vi.fn() }));
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
import { getAuthService } from '../../../../src/host/services/auth/authService';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../../src/host/services/commandCenter/sessionTaskSlotLedger';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const SESSION = 'session-owned-by-u1';
const OWNER: AuthUser = { id: 'u1', email: 'u1@example.test' };
const MODULE_PATH = path.join(process.cwd(), 'dist/web/dev-fault-inject.cjs');
let hadModule = false;
const savedEnv = { ...process.env };

/** startBackgroundTask 永不 settle：终态由测试显式 emit，模拟任务自然完成。 */
class ControllableTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockReturnValue(new Promise(() => undefined));
  interruptBackgroundTask = vi.fn().mockResolvedValue(true);
  cancelBackgroundTask = vi.fn().mockResolvedValue(true);
  observeAgentEvents(): () => void { return () => undefined; }
}

const logsOf = (level: string) => harness.log.filter((entry) => entry.level === level);
const devFaultLines = () => logsOf('warn')
  .map((entry) => entry.message)
  .filter((message) => message.includes('dev_fault_inject'));
const fireAuth = (user: AuthUser | null) => {
  const status: AuthStatus = { isAuthenticated: user !== null, user, isLoading: false };
  for (const callback of [...harness.callbacks]) callback(user, status);
};
const seedUser = (user: AuthUser | null) => {
  (getAuthService() as unknown as { currentUser: AuthUser | null }).currentUser = user;
};
const armBlank = (ms: number, dataDir: string) => {
  process.env.NEO_DEV_FAULT = `auth_user_blank:${ms}`;
  const stateDir = path.join(dataDir, 'dev-fault');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'auth_user_blank.start'), '1');
};

beforeAll(() => {
  hadModule = fs.existsSync(MODULE_PATH);
  // 每次现编，避免读到上一次构建留下的旧产物
  esbuild.buildSync({
    entryPoints: ['src/web/devFaultInject.ts'], outfile: MODULE_PATH,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'error',
  });
});

afterAll(() => {
  if (!hadModule) fs.rmSync(MODULE_PATH, { force: true });
});

describe('auth_user_blank 把 getCurrentUser 读空的后台任务收口', () => {
  let tmpDir: string;
  let devDir: string;
  let coreDb: DatabaseService;
  let connection: Database.Database;

  async function spawnAndComplete(manager: ControllableTaskManager, center: SessionCommandCenter, conclusion = '周报已写好'): Promise<string> {
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
    manager.emit('task_completed', { type: 'task_completed', sessionId: SESSION, data: { taskId: spawned.task.id, conclusion } });
    return spawned.task.id;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    harness.log.length = 0;
    harness.callbacks.length = 0;
    harness.sendMessage = vi.fn(async () => {
      await getSessionManager().addMessageToSession(SESSION, {
        id: `wake-reply-${Math.random()}`, role: 'assistant', content: '周报已汇总并交付', timestamp: Date.now(),
      });
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-blank-restore-'));
    devDir = path.join(tmpDir, '.code-agent-dev2');
    fs.mkdirSync(devDir);
    process.env = { ...savedEnv };
    process.env.CODE_AGENT_DATA_DIR = devDir;
    delete process.env.NEO_DEV_FAULT;
    seedUser(OWNER);
    // 产线注册的 addAuthChangeCallback 保持真实行为，同时把回调捕获给 fireAuth 代发。
    const auth = getAuthService();
    const realAdd = auth.addAuthChangeCallback.bind(auth);
    vi.spyOn(auth, 'addAuthChangeCallback').mockImplementation((callback) => {
      harness.callbacks.push(callback);
      const unsubscribe = realAdd(callback);
      return () => {
        unsubscribe();
        const index = harness.callbacks.indexOf(callback);
        if (index > -1) harness.callbacks.splice(index, 1);
      };
    });
    // 清掉编译模块内可能残留的窗口状态：env 未布防时读一次即复位（开关未开 → 原样放行）。
    auth.getCurrentUser();
    resetSessionCommandCenterForTest();
    resetSessionTaskConcurrencyPoolForTest();
    getSessionManager().clearCache();
    coreDb = new DatabaseService();
    connection = new Database(path.join(devDir, 'code-agent.db'));
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
    seedUser(null);
    resetSessionCommandCenterForTest();
    resetSessionTaskConcurrencyPoolForTest();
    harness.db = null;
    try { coreDb.close(); } catch { /* noop */ }
    process.env = { ...savedEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function messageRows(): Array<{ id: string; role: string; content: string; metadata: unknown }> {
    const raw = connection.prepare('SELECT id, role, content, metadata FROM messages WHERE session_id = ?').all(SESSION) as Array<{
      id: string; role: string; content: string; metadata: string | null;
    }>;
    return raw.map((row) => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : undefined }));
  }

  function persistenceCtx(): ContextAssemblyCtx {
    return {
      runtime: {
        sessionId: SESSION, messages: [], historyVisibility: 'meta',
        persistMessage: (message: Message) => getSessionManager().addMessageToSession(SESSION, message),
      },
      recordContextEventsForMessage: vi.fn(),
    } as unknown as ContextAssemblyCtx;
  }

  it('短窗读空后自行恢复：持久化等过窗口写成，settle 落一条已完成结果行加一次汇报', async () => {
    const shortMs = Math.floor(BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS / 2);
    armBlank(shortMs, devDir);

    const ctx = persistenceCtx();
    const pending = addAndPersistMessage(ctx, {
      id: 'pending-assistant', role: 'assistant', content: '整理三份会议记录', timestamp: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(0);
    // 窗口内：会话对「读空的 owner」不可写 → 进入 owner 等待
    expect(logsOf('warn').some((entry) => entry.details?.reason === 'message_persistence_waiting_for_owner')).toBe(true);
    expect(messageRows()).toHaveLength(0);
    expect(devFaultLines()).toEqual([`dev_fault_inject auth_user_blank blank ${shortMs}ms`]);

    // 窗口（INTERVAL/2）短于首个重试间隔（INTERVAL）：第一轮定时器重试落到窗口外
    await vi.advanceTimersByTimeAsync(BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS);
    await pending;
    expect(logsOf('warn').some((entry) => entry.details?.reason === 'message_persistence_owner_resumed')).toBe(true);
    expect(devFaultLines()).toEqual([
      `dev_fault_inject auth_user_blank blank ${shortMs}ms`,
      'dev_fault_inject auth_user_blank recovered',
    ]);

    const manager = new ControllableTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {});
    const taskId = await spawnAndComplete(manager, center);
    await vi.waitFor(() => expect(
      messageRows().some((row) => row.id === `session-task-result-${taskId}`)
      && messageRows().some((row) => row.role === 'assistant' && row.id.startsWith('wake-reply-')),
    ).toBe(true));

    const rows = messageRows();
    const resultRows = rows.filter((row) => row.id.startsWith('session-task-result-'));
    expect(resultRows).toHaveLength(1);
    expect(resultRows[0].id).toBe(`session-task-result-${taskId}`);
    expect(resultRows[0].content).toBe('[任务结果] 周报｜已完成｜周报已写好');
    expect((resultRows[0].metadata as { backgroundTaskResult?: { status?: string } }).backgroundTaskResult?.status).toBe('completed');
    const wakeRows = rows.filter((row) => row.role === 'assistant' && row.id.startsWith('wake-reply-'));
    expect(wakeRows).toHaveLength(1);
    expect(wakeRows[0].content).toBe('周报已汇总并交付');
    console.info('TEST-EVIDENCE rows:', JSON.stringify(rows));
    console.info('TEST-EVIDENCE waiting/resumed logs:', JSON.stringify(logsOf('warn').filter((entry) => (
      entry.details?.reason === 'message_persistence_waiting_for_owner'
      || entry.details?.reason === 'message_persistence_owner_resumed'
    ))));

    await vi.advanceTimersByTimeAsync(BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS * (BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS + 2));
    expect(messageRows().filter((row) => row.id.startsWith('session-task-result-'))).toHaveLength(1);
    expect(logsOf('warn').some((entry) => entry.details?.reason === 'message_persistence_not_accessible_retries_exhausted')).toBe(false);
  });

  it('长窗盖过两组重试界：持久化耗尽出登录句，恢复后恰好一行结果且无磁盘措辞', async () => {
    // 长窗盖住 message_persistence 与 terminal_projection 两组重试界：
    // 两组都在窗内耗尽 → 走 exhausted/迟到 owner 分支，恢复靠登录态信号。
    const longMs = BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS * (BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS + 2) * 2;
    armBlank(longMs, devDir);

    const pending = addAndPersistMessage(persistenceCtx(), {
      id: 'pending-assistant', role: 'assistant', content: '整理三份会议记录', timestamp: Date.now(),
    }).catch((error: unknown) => error as Error);
    await vi.advanceTimersByTimeAsync(BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS * (BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS + 2));
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('MessagePersistenceError');
    expect((error as Error).message).toBe('登录状态已变化，任务已停止，可以重新登录后重试。');
    expect(logsOf('warn').some((entry) => entry.details?.reason === 'message_persistence_not_accessible_retries_exhausted')).toBe(true);
    expect(messageRows()).toHaveLength(0);
    expect(devFaultLines()).toEqual([`dev_fault_inject auth_user_blank blank ${longMs}ms`]);

    const manager = new ControllableTaskManager();
    const center = new SessionCommandCenter(manager as unknown as TaskManager, {});
    const spawned = await center.spawn({
      sessionId: SESSION, title: '周报', shortName: '周报', laneKey: 'a', submissionKey: 'a', prompt: '汇总周报',
      workspaceScope: createWorkspaceScope('p', [{ sourceId: 's', path: tmpDir, role: 'primary', access: 'read_write' }]),
    });
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission');
    manager.emit('task_error', { type: 'task_error', sessionId: SESSION, data: { taskId: spawned.task.id, error: (error as Error).message } });
    // 长窗仍未结束：终态投影重试也在窗内耗尽，转入等 owner 登录态信号
    await vi.advanceTimersByTimeAsync(BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS * (BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS + 2));
    expect(logsOf('warn').some((entry) => entry.details?.reason === 'terminal_projection_not_accessible_retries_exhausted')).toBe(true);
    expect(messageRows()).toHaveLength(0);

    // 窗口耗尽 + 登录恢复信号：迟到的投影补投恰好一行结果
    await vi.advanceTimersByTimeAsync(longMs);
    fireAuth(OWNER);
    await vi.waitFor(() => expect(messageRows().some((row) => row.id === `session-task-result-${spawned.task.id}`)).toBe(true));
    // 迟到的投影补投走的是「耗尽 → 等 owner 登录态信号」链路
    await vi.waitFor(() => expect(
      logsOf('warn').some((entry) => entry.details?.reason === 'terminal_projection_late_owner_written'),
    ).toBe(true));
    // 结果行/停止说明/唤醒失败句分属不同补写链：冲掉微任务把整组行收齐再读
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const rows = messageRows();
    const resultRows = rows.filter((row) => row.id.startsWith('session-task-result-'));
    expect(resultRows).toHaveLength(1);
    expect(resultRows[0].content).toContain('登录状态已变化，任务已停止，可以重新登录后重试。');
    for (const row of rows) {
      expect(row.content).not.toMatch(/磁盘|数据库|disk|database|SQLite/i);
    }
    console.info('TEST-EVIDENCE rows:', JSON.stringify(rows));
    console.info('TEST-EVIDENCE exhausted log:', JSON.stringify(logsOf('warn').filter((entry) => (
      entry.details?.reason === 'message_persistence_not_accessible_retries_exhausted'
    ))));
    console.info('TEST-EVIDENCE all warn logs:', JSON.stringify(logsOf('warn').map((entry) => ({
      message: entry.message, reason: entry.details?.reason,
    }))));
    console.info('TEST-EVIDENCE dev-fault lines:', JSON.stringify(devFaultLines()));
  });
});
