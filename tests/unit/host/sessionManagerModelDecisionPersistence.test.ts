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

import type { Message, ModelDecisionEventData } from '../../../src/shared/contract';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const fallbackDecision: ModelDecisionEventData = {
  turnId: 'turn-1',
  requestedProvider: 'moonshot', requestedModel: 'kimi-k2.5',
  resolvedProvider: 'zhipu', resolvedModel: 'glm-5',
  role: null, billingMode: 'unknown',
  fallbackFrom: 'moonshot/kimi-k2.5',
  reason: 'fallback-availability',
};

/** 路由 chip 的决策记录随消息落库：写入 metadata.modelDecision，重开会话读回 Message.modelDecision。 */
describe('message modelDecision persistence', () => {
  let tmpDir: string;
  let previousDataDir: string | undefined;
  let coreDb: DatabaseService;
  let coreConnection: Database.Database;
  let repo: SessionRepository;
  let sessionManager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-model-decision-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
    coreDb = new DatabaseService();
    coreConnection = new Database(path.join(tmpDir, 'code-agent.db'));
    applySchema(coreConnection, logger as never);
    applySessionsMigrations(coreConnection, logger as never);
    repo = new SessionRepository(coreConnection);
    Object.assign(coreDb as unknown as Record<string, unknown>, { db: coreConnection, sessionRepo: repo });
    vi.spyOn(coreDb, 'logAuditEvent').mockImplementation(() => undefined);
    coreDatabase.current = coreDb;
    sessionManager = new SessionManager();
    coreDb.createSessionWithId('s1', { title: 's1', modelConfig: { provider: 'zhipu', model: 'glm-5' } });
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

  const assistant = (id: string, extra: Partial<Message> = {}): Message => ({
    id, role: 'assistant', content: '好的', timestamp: 100, ...extra,
  });

  it('repository round-trip: decision restored equal, other metadata keys survive', () => {
    repo.addMessage('s1', assistant('a1', { modelDecision: fallbackDecision, metadata: { turnQuality: { score: 1 } } as never }));
    const [m] = repo.getMessages('s1');
    expect(m.modelDecision).toEqual(fallbackDecision);
    expect(m.metadata).toEqual({ turnQuality: { score: 1 } });
    const raw = JSON.parse((coreConnection.prepare('SELECT metadata FROM messages WHERE id = ?').get('a1') as { metadata: string }).metadata);
    expect(raw.modelDecision).toEqual(fallbackDecision);
  });

  it('message without a decision (old rows) loads with no modelDecision and no metadata', () => {
    repo.addMessage('s1', assistant('a2'));
    const [m] = repo.getMessages('s1');
    expect(m.modelDecision).toBeUndefined();
    expect(m.metadata).toBeUndefined();
    expect((coreConnection.prepare('SELECT metadata FROM messages WHERE id = ?').get('a2') as { metadata: unknown }).metadata).toBeNull();
  });

  it('updateMessage that rewrites metadata keeps the stored decision', () => {
    repo.addMessage('s1', assistant('a3', { modelDecision: fallbackDecision }));
    repo.updateMessage('a3', { metadata: { turnQuality: { score: 2 } } as never }, 's1');
    const [m] = repo.getMessages('s1');
    expect(m.modelDecision).toEqual(fallbackDecision);
    expect(m.metadata).toEqual({ turnQuality: { score: 2 } });
  });

  it('SessionManager.addMessageToSession -> reopen -> getMessages carries the decision', async () => {
    await sessionManager.addMessageToSession('s1', assistant('a4', { modelDecision: fallbackDecision }));
    await sessionManager.dispose();
    sessionManager = new SessionManager();
    const messages = await sessionManager.getMessages('s1');
    expect(messages.find((m) => m.id === 'a4')?.modelDecision).toEqual(fallbackDecision);
  });
});
