// recall pack（packMemoryEntries）按与 searchMemories 同一使用增益排序。
// 真 in-memory sqlite + MemoryRepository，经公开入口 packMemoryEntries；固定假时钟。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../src/host/config/configPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/config/configPaths')>()),
  getUserConfigDir: () => mockConfigDir.dir,
}));
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/services/infra/logger')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { packMemoryEntries } from '../../../src/host/memory/memoryEntryRuntime';
import { MemoryRepository } from '../../../src/host/services/core/repositories/MemoryRepository';
import { applyMemoriesFtsSchema } from '../../../src/shared/memoriesFts.sql';

const NOW = 1_900_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL,
      summary TEXT, source TEXT NOT NULL, project_path TEXT, session_id TEXT,
      confidence REAL NOT NULL DEFAULT 1.0, metadata TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active', deprecated_by TEXT,
      access_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, last_accessed_at INTEGER
    );
  `);
}

function insertRow(db: BetterSqlite3.Database, row: {
  id: string; content: string; confidence?: number; accessCount?: number;
  updatedAt?: number; lastAccessedAt?: number | null; metadata?: Record<string, unknown>;
}): void {
  db.prepare(`
    INSERT INTO memories (id, type, category, content, summary, source, confidence, metadata, status, access_count, created_at, updated_at, last_accessed_at)
    VALUES (?, 'project_knowledge', 'context', ?, ?, 'manual', ?, ?, 'active', ?, ?, ?, ?)
  `).run(
    row.id, row.content, row.content, row.confidence ?? 1, JSON.stringify(row.metadata ?? {}),
    row.accessCount ?? 0, row.updatedAt ?? NOW, row.updatedAt ?? NOW, row.lastAccessedAt ?? null,
  );
}

describe('packMemoryEntries — 使用增益排序', () => {
  let db: BetterSqlite3.Database;
  let repo: MemoryRepository;
  let tmpDir: string;
  let memDir: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    db = new Database(':memory:');
    createSchema(db);
    applyMemoriesFtsSchema(db);
    repo = new MemoryRepository(db);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-usage-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
    await fs.mkdir(memDir, { recursive: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('(a) 用过且最近的记忆即使基础分略低，也排在没用过的之前', async () => {
    insertRow(db, { id: 'unused', content: '周报格式 A', confidence: 1.0, updatedAt: NOW - DAY });
    insertRow(db, {
      id: 'used', content: '周报格式 B', confidence: 0.95, updatedAt: NOW - 20 * DAY,
      accessCount: 5, lastAccessedAt: NOW - DAY,
    });

    const packed = await packMemoryEntries({ maxItems: 8 }, repo);
    expect(packed.items.map((i) => i.entryId)).toEqual(['db:used', 'db:unused']);
  });

  it('(b) 无使用数据时保持旧序与旧分（增益恒为 1）', async () => {
    insertRow(db, { id: 'newer', content: '记忆 新', confidence: 1.0, updatedAt: NOW - DAY });
    insertRow(db, { id: 'older', content: '记忆 旧', confidence: 1.0, updatedAt: NOW - 5 * DAY });
    insertRow(db, { id: 'lowconf', content: '记忆 低', confidence: 0.5, updatedAt: NOW });

    const packed = await packMemoryEntries({ maxItems: 8 }, repo);
    // items 经 antiLostInMiddleOrder 重排，这里按 id 核对分数（旧公式：25 active + 12*confidence）
    const scores = Object.fromEntries(packed.items.map((i) => [i.entryId, i.score]));
    expect(scores).toEqual({ 'db:newer': 37, 'db:older': 37, 'db:lowconf': 31 });
  });

  it('(c) light 文件记忆的使用度在镜像行上，也要带进排序', async () => {
    for (const [file, id] of [['fresh.md', 'entry_fresh'], ['used.md', 'entry_used']]) {
      await fs.writeFile(path.join(memDir, file), `---
name: ${id}
description: ${id}
type: project
entry_id: ${id}
status: active
source: knowledge_inbox
schema_version: 2
---

${id} body.
`, 'utf-8');
    }
    // used.md 文件更旧：没有使用度时按 updatedAt 排在 fresh 之后
    await fs.utimes(path.join(memDir, 'used.md'), new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
    await fs.utimes(path.join(memDir, 'fresh.md'), new Date(NOW - DAY), new Date(NOW - DAY));
    insertRow(db, {
      id: 'mirror-used', content: 'entry_used body.', accessCount: 6, lastAccessedAt: NOW - DAY,
      metadata: { memoryEntry: { schemaVersion: 2, id: 'entry_used', status: 'active', kind: 'project', scope: 'global', sourceOfTruth: 'light_file', filePath: 'used.md' } },
    });

    const packed = await packMemoryEntries({ maxItems: 8 }, repo);
    expect(packed.items.map((i) => i.entryId)).toEqual(['entry_used', 'entry_fresh']);
  });
});
