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

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => {
    if (!mockDb.current) throw new Error('Database not initialized');
    return mockDb.current;
  },
}));

vi.mock('../../../src/host/model/quickModel', () => ({
  memoryTask: vi.fn(async () => ({
    success: true,
    content: '{"actions":[],"conflicts":[]}',
  })),
}));

import { applySchema } from '../../../src/host/services/core/database/schema';
import { MemoryRepository } from '../../../src/host/services/core/repositories/MemoryRepository';
import { batchReviewMemoryEntries } from '../../../src/host/memory/memoryEntryReview';
import { consolidateLightMemory } from '../../../src/host/lightMemory/consolidation';
import { listUnifiedMemoryEntries } from '../../../src/host/memory/memoryEntryRuntime';
import { proposeProjectMemoryModule } from '../../../src/host/tools/modules/lightMemory/proposeProjectMemory';
import type { CanUseToolFn, Logger, ToolContext } from '../../../src/host/protocol/tools';

const schemaLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

function createDb(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      source TEXT NOT NULL,
      project_path TEXT,
      session_id TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      metadata TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      deprecated_by TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER
    );
  `);
  applySchema(db, schemaLogger);
  return db;
}

const allow: CanUseToolFn = async () => ({ allow: true });

function toolContext(workingDir: string): ToolContext {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    sessionId: 'real-shape-test-session',
    workingDir,
    abortSignal: new AbortController().signal,
    logger,
  } as ToolContext;
}

async function invoke(handler: Awaited<ReturnType<typeof proposeProjectMemoryModule.createHandler>>, projectDir: string, topic: 'purpose' | 'key-files' | 'conventions') {
  return handler.execute({
    topic,
    summary: 'Household notes',
    content: 'This folder stores ordinary household notes.',
    sources: ['notes.md'],
  }, toolContext(projectDir), allow);
}

describe('ProposeProjectMemory real light-file and SQLite shapes', () => {
  let configDir: string;
  let projectDir: string;
  let db: BetterSqlite3.Database;
  let repo: MemoryRepository;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'propose-memory-real-'));
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'propose-memory-real-project-'));
    mockConfigDir.dir = configDir;
    await fs.writeFile(path.join(projectDir, 'notes.md'), 'Ordinary household notes.\n', 'utf8');
    db = createDb();
    repo = new MemoryRepository(db);
    mockDb.current = repo;
  });

  afterEach(async () => {
    mockDb.current = null;
    db.close();
    await fs.rm(configDir, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('reproduces candidate status through CLI, SQLite mirror rebuild, and consolidation', async () => {
    const handler = await proposeProjectMemoryModule.createHandler();
    const cliProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'propose-memory-cli-project-'));
    try {
      await fs.writeFile(path.join(cliProjectDir, 'notes.md'), 'CLI-shaped notes.\n', 'utf8');
      mockDb.current = {
        listMemories: () => {
          throw new Error('Database not initialized');
        },
      };
      const cliFirst = await invoke(handler, cliProjectDir, 'purpose');
      const cliSecond = await invoke(handler, cliProjectDir, 'purpose');
      expect(cliFirst.meta).toMatchObject({ outcome: 'written', status: 'candidate' });
      expect(cliSecond.meta).toMatchObject({ outcome: 'exists', status: 'candidate' });
      if (cliSecond.ok) {
        expect(cliSecond.output).toContain('status: candidate');
        expect(cliSecond.output).toContain('still waiting for confirmation in Settings -> Memory');
      }

      mockDb.current = repo;
      const first = await invoke(handler, projectDir, 'key-files');
      const second = await invoke(handler, projectDir, 'key-files');
      expect(first.meta).toMatchObject({ outcome: 'written', status: 'candidate' });
      expect(second.meta).toMatchObject({ outcome: 'exists', status: 'candidate' });
      if (!second.ok) throw new Error(second.error);
      console.log('REAL_REPRO_DB_SECOND_OUTPUT\n' + second.output);
      expect(second.output).toContain('status: candidate');
      expect(second.output).toContain('takes effect only after you confirm it there.');

      const listedBeforeRebuild = await listUnifiedMemoryEntries(repo);
      const draftBeforeRebuild = listedBeforeRebuild.entries.find((entry) => entry.id === second.meta?.id);
      expect(draftBeforeRebuild?.status).toBe('candidate');

      const rebuild = await import('../../../src/host/memory/memoryEntryRuntime')
        .then(({ rebuildMemoryMirrorFromLightFiles }) => rebuildMemoryMirrorFromLightFiles(repo));
      expect(rebuild.skipped).toEqual([]);
      const afterRebuild = await invoke(handler, projectDir, 'key-files');
      expect(afterRebuild.meta).toMatchObject({ outcome: 'exists', status: 'candidate' });

      const consolidation = await consolidateLightMemory({ force: true, db: repo, instructionFiles: [] });
      expect(consolidation.error).toBeUndefined();
      const afterConsolidation = await invoke(handler, projectDir, 'key-files');
      expect(afterConsolidation.meta).toMatchObject({ outcome: 'exists', status: 'candidate' });
      const listedAfterConsolidation = await listUnifiedMemoryEntries(repo);
      expect(listedAfterConsolidation.entries.find((entry) => entry.id === second.meta?.id)?.status).toBe('candidate');
    } finally {
      await fs.rm(cliProjectDir, { recursive: true, force: true });
    }
  });

  it('keeps the candidate until the Settings -> Memory batch review confirms it', async () => {
    const handler = await proposeProjectMemoryModule.createHandler();
    const first = await invoke(handler, projectDir, 'conventions');
    expect(first.meta).toMatchObject({ outcome: 'written', status: 'candidate' });
    const id = String(first.meta?.id);

    const second = await invoke(handler, projectDir, 'conventions');
    expect(second.meta).toMatchObject({ outcome: 'exists', status: 'candidate' });
    if (!second.ok) throw new Error(second.error);
    expect(second.output).toContain('This draft is still waiting for confirmation in Settings -> Memory; it takes effect only after you confirm it there.');

    const review = await batchReviewMemoryEntries(repo, { entryIds: [id], decision: 'approve' });
    expect(review.skipped).toEqual([]);
    expect(review.updated).toHaveLength(1);
    expect(review.updated[0]?.status).toBe('active');

    const afterConfirm = await invoke(handler, projectDir, 'conventions');
    expect(afterConfirm.meta).toMatchObject({ outcome: 'exists', status: 'active' });
    if (!afterConfirm.ok) throw new Error(afterConfirm.error);
    console.log('REAL_CONFIRM_ACTIVE_OUTPUT\n' + afterConfirm.output);
    expect(afterConfirm.output).toContain('status: active');
    expect(afterConfirm.output).toContain('This memory is in effect.');
  });
});
