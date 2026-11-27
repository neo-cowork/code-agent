import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { MemoryRecord } from '../../../src/host/services/core/repositories';
import type { MemoryChangeJournalContext } from '../../../src/shared/contract/memory';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/host/config/configPaths', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/config/configPaths')>(),
  getUserConfigDir: () => mockConfigDir.dir,
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createManualMemoryEntry } from '../../../src/host/memory/memoryEntryCreate';
import {
  listUnifiedMemoryEntries,
  rebuildMemoryMirrorFromLightFiles,
  updateMemoryEntry,
} from '../../../src/host/memory/memoryEntryRuntime';
import { archiveMemoryFile, listMemoryFiles } from '../../../src/host/lightMemory/lightMemoryIpc';

const PANEL_JOURNAL: MemoryChangeJournalContext = { actor: 'user_manual' };

function fakeDb() {
  const rows: MemoryRecord[] = [];
  return {
    rows,
    listMemories: vi.fn(() => rows),
    findMemoryByEntryId: vi.fn((entryId: string) => (
      rows.find((row) => (row.metadata?.memoryEntry as { id?: string } | undefined)?.id === entryId) ?? null
    )),
    listMemoriesWithInjectionFeedback: vi.fn(() => [] as MemoryRecord[]),
    createMemory: vi.fn((data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>) => {
      const next = {
        id: `mem-${rows.length + 1}`,
        ...data,
        accessCount: 0,
        createdAt: 1,
        updatedAt: 1,
      } as MemoryRecord;
      rows.push(next);
      return next;
    }),
    updateMemory: vi.fn((id: string, patch: Partial<MemoryRecord>) => {
      const target = rows.find((row) => row.id === id);
      if (target) Object.assign(target, patch);
    }),
    deleteMemory: vi.fn((id: string) => {
      const idx = rows.findIndex((row) => row.id === id);
      if (idx >= 0) rows.splice(idx, 1);
    }),
  };
}

describe('memory archive <-> file list host contract', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-archive-sync-'));
    mockConfigDir.dir = tmpDir;
    await fs.mkdir(path.join(tmpDir, 'memory'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('(a) manual add -> edit content -> archive in All memories rewrites the light file with status=archived and edited content', async () => {
    const db = fakeDb();
    const created = await createManualMemoryEntry(
      db,
      { kind: 'user', content: '周报控制在 300 字以内，先列要点' },
      PANEL_JOURNAL,
    );
    expect(created.created).toBe(true);

    const edited = await updateMemoryEntry(
      db,
      { entryId: created.entry.id, content: '周报控制在 200 字以内，先列要点' },
      { journal: PANEL_JOURNAL },
    );
    expect(edited.entry.content).toBe('周报控制在 200 字以内，先列要点');

    const archived = await updateMemoryEntry(
      db,
      { entryId: created.entry.id, status: 'archived' },
      { journal: PANEL_JOURNAL },
    );
    expect(archived.entry.status).toBe('archived');

    const files = await listMemoryFiles();
    const targetFile = files.find((file) => file.filename === created.entry.source.filePath);
    expect(targetFile).toMatchObject({
      filename: created.entry.source.filePath,
      status: 'archived',
      content: '周报控制在 200 字以内，先列要点',
    });
  });

  it('(b) manual add -> archiveMemoryFile + rebuildMemoryMirrorFromLightFiles marks unified entry status=archived', async () => {
    const db = fakeDb();
    const created = await createManualMemoryEntry(
      db,
      { kind: 'user', content: '读书会书签颜色是橙色' },
      PANEL_JOURNAL,
    );
    expect(created.created).toBe(true);
    const filename = created.entry.source.filePath;
    expect(filename).toBeTruthy();

    const archivedFile = await archiveMemoryFile(filename!);
    expect(archivedFile).toMatchObject({
      filename,
      status: 'archived',
    });

    await rebuildMemoryMirrorFromLightFiles(db, { journal: PANEL_JOURNAL });

    const { entries } = await listUnifiedMemoryEntries(db);
    const targetEntry = entries.find((entry) => entry.id === created.entry.id);
    expect(targetEntry).toMatchObject({
      id: created.entry.id,
      status: 'archived',
      content: '读书会书签颜色是橙色',
    });
  });
});
