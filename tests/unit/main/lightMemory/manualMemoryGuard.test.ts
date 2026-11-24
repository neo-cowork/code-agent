import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.unmock('better-sqlite3');

const config = vi.hoisted(() => ({ dir: '' }));
const quickTask = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/host/config/configPaths', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/config/configPaths')>(),
  getUserConfigDir: () => config.dir,
}));
vi.mock('../../../../src/host/model/quickModel', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/model/quickModel')>(),
  quickTask,
}));

import { applySchema } from '../../../../src/host/services/core/database/schema';
import { MemoryRepository } from '../../../../src/host/services/core/repositories/MemoryRepository';
import { createLogger } from '../../../../src/host/services/infra/logger';
import { readMemoryFile, writeLightMemoryFile } from '../../../../src/host/lightMemory/lightMemoryIpc';
import { writeDurableFacts } from '../../../../src/host/lightMemory/durableFactWriter';
import { runRoleWriteBack } from '../../../../src/host/services/roleAssets/roleWriteBack';
import { ensureRoleAssetDirs } from '../../../../src/host/services/roleAssets/roleAssetService';
import { createManualMemoryEntry } from '../../../../src/host/memory/memoryEntryCreate';
import { batchReviewMemoryEntries } from '../../../../src/host/memory/memoryEntryReview';
import { listUnifiedMemoryEntries, updateMemoryEntry } from '../../../../src/host/memory/memoryEntryRuntime';

const original = 'The weekly meeting is on Tuesday.';
const replacement = 'The weekly meeting is on Wednesday.';
const name = 'Weekly meeting';
const description = 'Day of the weekly meeting';
const roleId = 'meeting-planner';

describe.each([
  { writer: 'session judge', source: 'session-judge', type: 'user' },
  { writer: 'role write-back', source: 'role-writeback', type: 'reference' },
] as const)('$writer same-filename writes', ({ source, type }) => {
  let connection: Database.Database;
  let repo: MemoryRepository;
  let memoryDir: string;

  beforeEach(async () => {
    config.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-memory-guard-'));
    memoryDir = path.join(config.dir, 'memory');
    connection = new Database(':memory:');
    applySchema(connection, createLogger('ManualMemoryGuardTest'));
    repo = new MemoryRepository(connection);
    if (source === 'role-writeback') await ensureRoleAssetDirs(roleId);
  });

  afterEach(async () => {
    connection.close();
    await fs.rm(config.dir, { recursive: true, force: true });
    quickTask.mockReset();
  });

  async function write(filename: string, content = replacement) {
    if (source === 'session-judge') {
      return writeDurableFacts([{ filename, name, description, content, type, confidence: 0.9 }]);
    }
    quickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({ memories: [{ layer: 'global', filename, name, description, content }] }),
    });
    return runRoleWriteBack({ roleId, taskPrompt: 'Update the weekly meeting schedule', finalOutput: content });
  }

  async function createManual() {
    const { entry } = await createManualMemoryEntry(repo, { kind: 'user', content: original }, { actor: 'user_manual' });
    const filename = entry.source.filePath!;
    const filePath = path.join(memoryDir, filename);
    const digest = createHash('sha256').update(replacement.toLowerCase()).digest('hex').slice(0, 8);
    const pending = filename.replace(/\.md$/, `-pending-${digest}.md`);
    return { originalId: entry.id, filename, filePath, pending, before: await fs.readFile(filePath) };
  }

  async function proposeAndGetId(filename: string, pending: string): Promise<string> {
    await write(filename);
    const { entries } = await listUnifiedMemoryEntries(repo);
    const candidate = entries.find((entry) => entry.source.filePath === pending);
    expect(candidate).toMatchObject({ status: 'candidate', supersedes: filename });
    return candidate!.id;
  }

  it('keeps the manual file byte-identical and writes a candidate excluded from INDEX.md', async () => {
    const { filename, filePath, pending, before } = await createManual();
    const result = await write(filename);
    expect(await fs.readFile(filePath)).toEqual(before);
    expect(result).toMatchObject(source === 'session-judge'
      ? { written: 0, skipped: 1, files: [], active: 0, dropped: 0 }
      : { executed: true, written: 0 });
    expect(await readMemoryFile(pending)).toMatchObject({
      status: 'candidate', supersedes: filename, source, type, content: replacement,
    });
    const index = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    expect(index).toContain(`[${filename}]`);
    expect(index).not.toContain(pending);
  });

  it('skips normalized-equivalent text without touching files', async () => {
    const { filename, filePath, before } = await createManual();
    const beforeFiles = await fs.readdir(memoryDir);
    await write(filename, 'THE weekly  meeting is on\n TUESDAY.');
    expect(await fs.readFile(filePath)).toEqual(before);
    expect(await fs.readdir(memoryDir)).toEqual(beforeFiles);
  });

  it('deduplicates concurrent writes and leaves a rejected proposal untouched on retry', async () => {
    const { filename, filePath, pending, before } = await createManual();
    await Promise.all([write(filename), write(filename)]);
    const id = await proposeAndGetId(filename, pending);
    const files = await fs.readdir(memoryDir);
    expect(files.filter((file) => file.includes('-pending-'))).toEqual([pending]);
    await batchReviewMemoryEntries(repo, { entryIds: [id], decision: 'reject' });
    expect(repo.listMemoryJournal({ entryId: id, limit: 1 })[0]?.actor).toBe('user_manual');
    expect(await readMemoryFile(pending)).toMatchObject({ status: 'rejected', supersedes: filename, source });
    const rejected = await fs.readFile(path.join(memoryDir, pending));
    await write(filename);
    expect(await fs.readdir(memoryDir)).toEqual(files);
    expect(await fs.readFile(path.join(memoryDir, pending))).toEqual(rejected);
    expect(await fs.readFile(filePath)).toEqual(before);
  });

  it.each(['missing', 'non-manual'])('preserves the legacy write bytes when the target is %s', async (mode) => {
    const filename = 'weekly-meeting.md';
    if (mode === 'non-manual') await writeLightMemoryFile({ filename, name, description, type, content: original });
    const result = await write(filename);
    expect(result).toMatchObject(source === 'session-judge'
      ? { written: 1, skipped: 0, files: [filename], active: 1, dropped: 0 }
      : { executed: true, written: 1 });
    expect(await fs.readFile(path.join(memoryDir, filename), 'utf-8')).toBe(
      `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${replacement}\n`,
    );
    expect(await fs.readdir(memoryDir)).toEqual(['INDEX.md', filename]);
  });

  it.each(['batch approval', 'single-entry update'])('archives the original and preserves its body on %s', async (mode) => {
    const { originalId, filename, pending } = await createManual();
    const id = await proposeAndGetId(filename, pending);
    if (mode === 'batch approval') {
      expect(await batchReviewMemoryEntries(repo, { entryIds: [id], decision: 'approve' })).toMatchObject({
        updated: [{ id, status: 'active' }], skipped: [],
      });
      const actors = [id, originalId].map((entryId) => repo.listMemoryJournal({ entryId, limit: 1 })[0]?.actor);
      expect(actors).toEqual(['user_manual', 'user_manual']);
    } else {
      expect(await updateMemoryEntry(repo, { entryId: id, status: 'active' })).toMatchObject({
        entry: { id, status: 'active' },
      });
    }
    expect(await readMemoryFile(pending)).toMatchObject({ status: 'active', supersedes: filename, source });
    expect(await readMemoryFile(filename)).toMatchObject({ status: 'archived', deprecatedBy: pending, content: original });
    const index = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    expect(index).toContain(`[${pending}]`);
    expect(index).not.toContain(`[${filename}]`);
  });

  it.each(['missing', 'archived'])('activates the candidate when the original is already %s', async (status) => {
    const { filename, filePath, pending } = await createManual();
    const id = await proposeAndGetId(filename, pending);
    if (status === 'missing') {
      await fs.unlink(filePath);
    } else {
      const { entries } = await listUnifiedMemoryEntries(repo);
      const target = entries.find((entry) => entry.source.filePath === filename)!;
      await updateMemoryEntry(repo, { entryId: target.id, status: 'archived' });
    }
    const before = await readMemoryFile(filename);
    await batchReviewMemoryEntries(repo, { entryIds: [id], decision: 'approve' });
    expect(await readMemoryFile(pending)).toMatchObject({ status: 'active' });
    expect(await readMemoryFile(filename)).toEqual(before);
  });
});
