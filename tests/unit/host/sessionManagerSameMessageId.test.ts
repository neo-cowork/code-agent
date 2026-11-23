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

const coreDatabase = vi.hoisted(() => ({ current: null as DatabaseService | null }));

vi.mock('../../../src/host/services/core', () => ({
  getDatabase: () => {
    if (!coreDatabase.current) throw new Error('core database unavailable');
    return coreDatabase.current;
  },
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));

vi.mock('../../../src/host/services/infra/supabaseService', () => ({
  getSupabase: () => null,
  isSupabaseInitialized: () => false,
}));

import { SessionManager } from '../../../src/host/services/infra/sessionManager';

import type { Message } from '../../../src/shared/contract';

/**
 * Two addMessageToSession writes that share a messages.id go through the
 * production SessionManager entry. The second write does not insert a second
 * row: the UNIQUE constraint is caught and updateMessage overwrites the row.
 */
describe('SessionManager same messages.id write', () => {
  let tmpDir: string;
  let previousDataDir: string | undefined;
  let coreDb: DatabaseService;
  let coreConnection: Database.Database;
  let repo: SessionRepository;
  let sessionManager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-same-message-id-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
    coreDb = new DatabaseService();
    coreConnection = new Database(path.join(tmpDir, 'code-agent.db'));
    applySchema(coreConnection, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never);
    applySessionsMigrations(coreConnection, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never);
    repo = new SessionRepository(coreConnection);
    Object.assign(coreDb as unknown as Record<string, unknown>, { db: coreConnection, sessionRepo: repo });
    vi.spyOn(coreDb, 'logAuditEvent').mockImplementation(() => undefined);
    coreDatabase.current = coreDb;
    sessionManager = new SessionManager();
    coreDb.createSessionWithId('s-retry', { title: '报价对比', modelConfig: { provider: 'zhipu', model: 'glm-5' } });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sessionManager?.dispose();
    coreDatabase.current = null;
    try { coreDb.close(); } catch { /* noop */ }
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a second addMessageToSession with the same id overwrites the one messages row', async () => {
    const messageId = 'delegation-retry-task-quote-same';
    const first: Message = {
      id: messageId,
      role: 'user',
      content: '请重新做一下报价对比',
      timestamp: 1_000,
    };
    const second: Message = {
      id: messageId,
      role: 'user',
      content: '请重新做一下报价对比，把缺的文件说明写出来',
      timestamp: 2_000,
    };

    await sessionManager.addMessageToSession('s-retry', first);
    await sessionManager.addMessageToSession('s-retry', second);

    const rows = coreConnection.prepare(
      'SELECT id, role, content, timestamp FROM messages WHERE session_id = ?',
    ).all('s-retry') as Array<{ id: string; role: string; content: string; timestamp: number }>;
    const loaded = await sessionManager.getMessages('s-retry');
    const finding = {
      rowCount: rows.length,
      loadedCount: loaded.length,
      storedContent: rows[0]?.content ?? null,
      storedTimestamp: rows[0]?.timestamp ?? null,
      firstContentKept: rows[0]?.content === first.content,
      overwritten: rows.length === 1
        && loaded.length === 1
        && rows[0]?.id === messageId
        && rows[0]?.content === second.content
        && rows[0]?.timestamp === second.timestamp
        && loaded[0]?.content === second.content,
    };
    console.log(`SAME_ID_WRITE ${JSON.stringify(finding)}`);
    expect(finding.overwritten, 'same clientMessageId overwrites the earlier messages row').toBe(true);
    expect(rows[0]?.content).not.toBe(first.content);
  });
});
