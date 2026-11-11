import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import type { SessionCommandTask } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import {
  BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS,
  BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS,
} from '../../../src/shared/constants/sessionCommandCenter';

// N-FIX-BG-WAKE-SKIPPED-SESSION-INACCESSIBLE-AFTER-LOGIN-RESTORE-REDRAFT：
// 产线入口 createForegroundWake()（默认依赖）+ 真 SessionManager + 真 sqlite；
// 只替换登录用户（可控）、TaskManager 外壳和 logger（捕获）。

const harness = vi.hoisted(() => ({
  db: null as unknown,
  user: null as { id: string } | null,
  callbacks: [] as Array<(user: { id: string } | null, status: string) => void>,
  log: [] as Array<{ level: string; message: string; details?: Record<string, unknown> }>,
  sendMessage: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
}));

vi.mock('../../../src/host/services/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/services/core')>()),
  getDatabase: () => harness.db,
}));
vi.mock('../../../src/host/services/core/databaseService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/services/core/databaseService')>()),
  getDatabase: () => harness.db,
}));
vi.mock('../../../src/host/services/auth/authService', () => ({
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
vi.mock('../../../src/host/services/infra/supabaseService', () => ({
  getSupabase: () => null,
  isSupabaseInitialized: () => false,
}));
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  const make = (level: string) => (message: string, details?: Record<string, unknown>) => {
    harness.log.push({ level, message, details });
  };
  return {
    ...original,
    createLogger: () => ({ debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') }),
  };
});
vi.mock('../../../src/host/task/TaskManager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/task/TaskManager')>();
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

import { createForegroundWake } from '../../../src/host/services/commandCenter/foregroundWake';
import { getSessionManager } from '../../../src/host/services/infra/sessionManager';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const SESSION = 'session-owned-by-u1';

function makeTask(overrides: Partial<SessionCommandTask> = {}): SessionCommandTask {
  return {
    id: 'task-1', sessionId: SESSION, title: '周报', shortName: '周报', laneKey: 'lane', submissionKey: 'sub',
    prompt: 'p', status: 'completed', attempt: 1, createdAt: 1, updatedAt: 1, resultText: '周报结果',
    workspaceScope: undefined as never,
    ...overrides,
  };
}

const logsOf = (level: string) => harness.log.filter((entry) => entry.level === level);
const fireAuth = (user: { id: string } | null) => {
  harness.user = user;
  for (const callback of [...harness.callbacks]) callback(user, user ? 'authenticated' : 'unauthenticated');
};

describe('foreground wake when the session is not accessible for the current owner', () => {
  let tmpDir: string;
  let previousDataDir: string | undefined;
  let coreDb: DatabaseService;
  let connection: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    harness.log.length = 0;
    harness.callbacks.length = 0;
    harness.user = null;
    harness.sendMessage = vi.fn(async () => {
      await getSessionManager().addMessageToSession(SESSION, {
        id: `wake-reply-${Math.random()}`, role: 'assistant', content: '周报已汇总', timestamp: Date.now(),
      });
    });
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-wake-owner-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
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
    coreDb.createSessionWithId('session-voice-like', {
      title: '语音', userId: 'u1', type: 'voice' as never, modelConfig: { provider: 'zhipu', model: 'glm-5' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    harness.db = null;
    try { coreDb.close(); } catch { /* noop */ }
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('delivers exactly once after the login is restored, with a distinguishable log reason', async () => {
    const wake = createForegroundWake();
    await wake(makeTask(), 'completed');

    expect(harness.sendMessage).not.toHaveBeenCalled();
    const waiting = logsOf('warn').find((entry) => entry.details?.reason === 'session_not_accessible_for_current_owner');
    expect(waiting?.details).toMatchObject({ sessionId: SESSION, taskId: 'task-1', ownerSignedIn: false });
    expect(harness.log.some((entry) => entry.message.includes('not a text chat session'))).toBe(false);
    expect(harness.callbacks).toHaveLength(1);

    fireAuth({ id: 'u1' });
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(harness.callbacks).toHaveLength(0));

    const reloaded = await getSessionManager().getSession(SESSION, 50);
    expect(reloaded?.messages.map((message) => message.content)).toContain('周报已汇总');

    // 定时器重试不会再投第二次
    await vi.advanceTimersByTimeAsync(BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS * BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS);
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('retries a bounded number of times, then logs one exhausted warn and runs no wake turn', async () => {
    const wake = createForegroundWake();
    await wake(makeTask(), 'completed');
    await vi.advanceTimersByTimeAsync(BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS * (BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS + 3));

    expect(harness.sendMessage).not.toHaveBeenCalled();
    const waiting = logsOf('warn').filter((entry) => entry.details?.reason === 'session_not_accessible_for_current_owner');
    expect(waiting).toHaveLength(BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS - 1);
    const exhausted = logsOf('warn').filter((entry) => entry.message.startsWith('Foreground wake dropped'));
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].details).toMatchObject({ attempts: BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS, ownerSignedIn: false });
    // 会话仍不可读，失败说明写不进去 → 留痕而不是静默
    expect(logsOf('warn').some((entry) => entry.message === 'Foreground wake failure note not recorded')).toBe(true);
    await vi.waitFor(() => expect(harness.callbacks).toHaveLength(0));
  });

  it('never delivers into the u1 session after a different user signs in', async () => {
    const wake = createForegroundWake();
    await wake(makeTask(), 'completed');
    fireAuth({ id: 'u2' });
    await vi.advanceTimersByTimeAsync(BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS * (BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS + 1));

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(logsOf('warn').some((entry) => entry.details?.ownerSignedIn === true)).toBe(true);
    const stored = connection.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(SESSION) as { n: number };
    expect(stored.n).toBe(0);
  });

  it('keeps the old skip log for a non-chat session', async () => {
    harness.user = { id: 'u1' };
    const wake = createForegroundWake();
    await wake(makeTask({ sessionId: 'session-voice-like' }), 'completed');

    expect(harness.sendMessage).not.toHaveBeenCalled();
    const skipped = harness.log.find((entry) => entry.message === 'Foreground wake skipped: not a text chat session');
    expect(skipped?.details).toMatchObject({ sessionId: 'session-voice-like', sessionType: 'voice' });
    expect(harness.callbacks).toHaveLength(0);
  });
});
