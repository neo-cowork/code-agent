// 设置面板「添加记忆」：走生产路由入口（registerMemoryHandlers → memoryEntryCreate），
// 真 light-memory 文件 + 真 sqlite（MemoryRepository），不手搓仓储 mock。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

vi.unmock('better-sqlite3');

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
const mockDb = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
}));
vi.mock('../../../src/host/services', () => ({
  getDatabase: () => {
    if (!mockDb.current) throw new Error('Database not initialized');
    return mockDb.current;
  },
  getSessionManager: () => ({}),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { applySchema } from '../../../src/host/services/core/database/schema';
import { MemoryRepository } from '../../../src/host/services/core/repositories/MemoryRepository';
import { registerMemoryHandlers } from '../../../src/host/ipc/memory.ipc';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { MemoryEntryCreateResult } from '../../../src/shared/contract/memory';

const schemaLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function createDb(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL,
      summary TEXT, source TEXT NOT NULL, project_path TEXT, session_id TEXT,
      confidence REAL NOT NULL DEFAULT 1.0, metadata TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active', deprecated_by TEXT,
      access_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER
    );
  `);
  applySchema(db, schemaLogger);
  return db;
}

type Handler = (event: unknown, request: unknown) => Promise<{ success: boolean; data?: unknown; error?: { message?: string } | string }>;

describe('memoryEntryCreate through the production MEMORY route', () => {
  let configDir: string;
  let db: BetterSqlite3.Database;
  let repo: MemoryRepository;
  let call: (request: Record<string, unknown>) => ReturnType<Handler>;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-create-'));
    mockConfigDir.dir = configDir;
    db = createDb();
    repo = new MemoryRepository(db);
    mockDb.current = repo;
    const handlers = new Map<string, Handler>();
    registerMemoryHandlers({ handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } } as never);
    // registerMemoryHandlers 同时注册 IPC_CHANNELS.MEMORY
    call = (request) => handlers.get(IPC_CHANNELS.MEMORY)!({}, request);
  });

  afterEach(async () => {
    mockDb.current = null;
    db.close();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  const create = (content: string, kind = 'user', extra: Record<string, unknown> = {}) =>
    call({ action: 'memoryEntryCreate', content, kind, ...extra });

  it('writes light file + mirror row + user_manual create journal row, marked as manual', async () => {
    const response = await create('  I prefer replies in Chinese  ');
    expect(response.success).toBe(true);
    const data = response.data as MemoryEntryCreateResult;
    expect(data).toMatchObject({ created: true, duplicate: false });
    expect(data.entry).toMatchObject({ kind: 'user', scope: 'global', status: 'active', content: 'I prefer replies in Chinese' });
    expect(data.entry.source.kind).toBe('manual');

    const files = await fs.readdir(path.join(configDir, 'memory'));
    const file = files.find((name) => name.startsWith('memory-'))!;
    const text = await fs.readFile(path.join(configDir, 'memory', file), 'utf8');
    expect(text).toContain('I prefer replies in Chinese');
    expect(text).toContain('source: manual');

    const rows = repo.listMemories({ includeArchived: true, includeCandidates: true });
    expect(rows).toHaveLength(1);
    const journal = repo.listMemoryJournal({ entryId: data.entry.id });
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ actor: 'user_manual', operation: 'create' });

    // 重新列出：仍在，且保留「手动添加」来源
    const listed = await call({ action: 'memoryEntries' });
    const entries = (listed.data as { entries: Array<{ id: string; source: { kind: string } }> }).entries;
    expect(entries.find((entry) => entry.id === data.entry.id)?.source.kind).toBe('manual');
  });

  it('project kind gets project scope', async () => {
    const response = await create('Release notes live in docs/releases', 'project', { projectPath: '/tmp/demo' });
    const data = response.data as MemoryEntryCreateResult;
    expect(data.entry).toMatchObject({ kind: 'project', scope: 'project', projectPath: '/tmp/demo' });
  });

  it('rejects empty content', async () => {
    const response = await create('   ');
    expect(response.success).toBe(false);
    expect(JSON.stringify(response.error)).toContain('MEMORY_CREATE_EMPTY');
    expect(repo.listMemories({ includeArchived: true, includeCandidates: true })).toHaveLength(0);
  });

  it('returns the existing entry instead of a second copy for normalized-equal content', async () => {
    const first = (await create('Reply in English')).data as MemoryEntryCreateResult;
    const second = (await create('  reply   in english ')).data as MemoryEntryCreateResult;
    expect(second).toMatchObject({ created: false, duplicate: true });
    expect(second.entry.id).toBe(first.entry.id);
    expect(repo.listMemories({ includeArchived: true, includeCandidates: true })).toHaveLength(1);
    const files = (await fs.readdir(path.join(configDir, 'memory'))).filter((name) => name.startsWith('memory-'));
    expect(files).toHaveLength(1);
  });

  it.each(['directive', 'session', 'pattern', 'nonsense'])('rejects forbidden kind %s', async (kind) => {
    const response = await create('Always do X', kind);
    expect(response.success).toBe(false);
    expect(JSON.stringify(response.error)).toContain('MEMORY_CREATE_KIND_FORBIDDEN');
    expect(repo.listMemories({ includeArchived: true, includeCandidates: true })).toHaveLength(0);
  });

  it('created entry can be edited then archived through the existing update action', async () => {
    const created = (await create('Short answers please')).data as MemoryEntryCreateResult;
    const edited = await call({ action: 'memoryEntryUpdate', entryId: created.entry.id, content: 'Short answers please, no emojis' });
    expect(edited.success).toBe(true);
    const archived = await call({ action: 'memoryEntryUpdate', entryId: created.entry.id, status: 'archived' });
    expect(archived).toMatchObject({ success: true, data: { entry: { status: 'archived', content: 'Short answers please, no emojis' } } });
  });

  it('a duplicate of an archived entry is allowed (only active entries count)', async () => {
    const created = (await create('Use tabs')).data as MemoryEntryCreateResult;
    await call({ action: 'memoryEntryUpdate', entryId: created.entry.id, status: 'archived' });
    const again = (await create('Use tabs')).data as MemoryEntryCreateResult;
    expect(again.created).toBe(true);
  });
});
