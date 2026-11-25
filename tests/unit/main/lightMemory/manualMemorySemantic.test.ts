import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.unmock('better-sqlite3');

const config = vi.hoisted(() => ({ dir: '' }));
const quickTask = vi.hoisted(() => vi.fn());
const memoryTask = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/host/config/configPaths', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/config/configPaths')>(),
  getUserConfigDir: () => config.dir,
}));
vi.mock('../../../../src/host/model/quickModel', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/model/quickModel')>(),
  quickTask,
  memoryTask,
}));

import { applySchema } from '../../../../src/host/services/core/database/schema';
import { MemoryRepository } from '../../../../src/host/services/core/repositories/MemoryRepository';
import { createLogger } from '../../../../src/host/services/infra/logger';
import { readMemoryFile } from '../../../../src/host/lightMemory/lightMemoryIpc';
import { writeDurableFacts } from '../../../../src/host/lightMemory/durableFactWriter';
import { runRoleWriteBack } from '../../../../src/host/services/roleAssets/roleWriteBack';
import { ensureRoleAssetDirs } from '../../../../src/host/services/roleAssets/roleAssetService';
import { createManualMemoryEntry } from '../../../../src/host/memory/memoryEntryCreate';
import { batchReviewMemoryEntries } from '../../../../src/host/memory/memoryEntryReview';
import { listUnifiedMemoryEntries } from '../../../../src/host/memory/memoryEntryRuntime';

const original = 'The weekly meeting is on Tuesday.';
const wednesday = 'The weekly meeting is on Wednesday.';
const roleId = 'meeting-planner';
const autoFilename = 'weekly-meeting-day.md';

describe.each([
  { writer: 'session judge', source: 'session-judge', type: 'user' },
  { writer: 'role write-back', source: 'role-writeback', type: 'reference' },
] as const)('$writer semantic reconcile', ({ source, type }) => {
  let connection: Database.Database;
  let repo: MemoryRepository;
  let memoryDir: string;
  let manual: { filename: string; before: Buffer };

  const reply = (value: unknown) => memoryTask.mockResolvedValue({
    success: true,
    content: typeof value === 'string' ? value : JSON.stringify(value),
  });

  beforeEach(async () => {
    config.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-memory-semantic-'));
    memoryDir = path.join(config.dir, 'memory');
    connection = new Database(':memory:');
    applySchema(connection, createLogger('ManualMemorySemanticTest'));
    repo = new MemoryRepository(connection);
    if (source === 'role-writeback') await ensureRoleAssetDirs(roleId);
  });

  afterEach(async () => {
    connection.close();
    await fs.rm(config.dir, { recursive: true, force: true });
    quickTask.mockReset();
    memoryTask.mockReset();
  });

  async function createManual() {
    const { entry } = await createManualMemoryEntry(repo, { kind: 'user', content: original }, { actor: 'user_manual' });
    const filename = entry.source.filePath!;
    manual = { filename, before: await fs.readFile(path.join(memoryDir, filename)) };
  }

  async function write(content: string) {
    if (source === 'session-judge') {
      return writeDurableFacts([{
        filename: autoFilename, name: 'Weekly meeting', description: 'Day of the weekly meeting', content, type, confidence: 0.9,
      }]);
    }
    quickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({ memories: [{
        layer: 'global', filename: autoFilename, name: 'Weekly meeting', description: 'Day of the weekly meeting', content,
      }] }),
    });
    return runRoleWriteBack({ roleId, taskPrompt: 'Update the weekly meeting schedule', finalOutput: content });
  }

  const pendingFiles = async () => (await fs.readdir(memoryDir)).filter((f) => f.includes('-pending-'));

  it('conflict → candidate superseding the manual entry, original bytes untouched', async () => {
    await createManual();
    reply({ label: 'conflict', filename: manual.filename });
    await write(wednesday);
    const [pending] = await pendingFiles();
    expect(await readMemoryFile(pending)).toMatchObject({
      status: 'candidate', supersedes: manual.filename.toLowerCase(), source, content: wednesday,
    });
    expect(await fs.readFile(path.join(memoryDir, manual.filename))).toEqual(manual.before);
    expect(await fs.readdir(memoryDir)).not.toContain(autoFilename);
    expect(await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8')).not.toContain(pending);
  });

  it('equivalent → nothing written', async () => {
    await createManual();
    const files = await fs.readdir(memoryDir);
    reply({ label: 'equivalent', filename: manual.filename });
    await write('We meet every Tuesday for the weekly meeting.');
    expect(await fs.readdir(memoryDir)).toEqual(files);
    expect(await fs.readFile(path.join(memoryDir, manual.filename))).toEqual(manual.before);
  });

  it('independent → written active', async () => {
    await createManual();
    reply({ label: 'independent', filename: null });
    await write('My favourite editor is Vim.');
    expect(await readMemoryFile(autoFilename)).toMatchObject({ content: 'My favourite editor is Vim.' });
    expect(await pendingFiles()).toEqual([]);
  });

  it.each([
    ['model error', 'error', () => memoryTask.mockRejectedValue(new Error('boom'))],
    ['unsuccessful result', 'model-failed', () => memoryTask.mockResolvedValue({ success: false, error: 'down' })],
    ['garbage reply', 'unparsable', () => memoryTask.mockResolvedValue({ success: true, content: 'sure thing!' })],
    ['unknown label', 'unparsable', () => memoryTask.mockResolvedValue({ success: true, content: '{"label":"maybe"}' })],
  ])('%s → candidate without supersedes', async (_name, reason, arrange) => {
    await createManual();
    arrange();
    const warn = vi.spyOn(Object.getPrototypeOf(createLogger('probe')), 'warn');
    await write(wednesday);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('treating as conflict'), expect.objectContaining({ reason }));
    warn.mockRestore();
    const [pending] = await pendingFiles();
    const candidate = await readMemoryFile(pending);
    expect(candidate).toMatchObject({ status: 'candidate', content: wednesday });
    expect(candidate?.supersedes).toBeUndefined();
    expect(await fs.readFile(path.join(memoryDir, manual.filename))).toEqual(manual.before);
  });

  it('timeout → candidate without supersedes', async () => {
    await createManual();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      memoryTask.mockReturnValue(new Promise(() => {}));
      const done = write(wednesday);
      // Let file IO reach the model call, then jump past the classifier timeout.
      await vi.waitFor(() => expect(memoryTask).toHaveBeenCalled(), { interval: 5 });
      await vi.advanceTimersByTimeAsync(60_000);
      await done;
    } finally {
      vi.useRealTimers();
    }
    const [pending] = await pendingFiles();
    expect((await readMemoryFile(pending))?.supersedes).toBeUndefined();
  });

  it('target filename not in the list → candidate without supersedes', async () => {
    await createManual();
    reply({ label: 'conflict', filename: 'not-in-list.md' });
    await write(wednesday);
    const [pending] = await pendingFiles();
    const candidate = await readMemoryFile(pending);
    expect(candidate?.status).toBe('candidate');
    expect(candidate?.supersedes).toBeUndefined();
  });

  it('repeated conflicting write does not stack candidates', async () => {
    await createManual();
    reply({ label: 'conflict', filename: manual.filename });
    await write(wednesday);
    await write(wednesday);
    expect(await pendingFiles()).toHaveLength(1);
  });

  it('no manual entries → memoryTask never called, entry written', async () => {
    await write(wednesday);
    expect(memoryTask).not.toHaveBeenCalled();
    expect(await readMemoryFile(autoFilename)).toMatchObject({ content: wednesday });
  });

  it('accepting the candidate archives the manual entry with deprecatedBy', async () => {
    await createManual();
    reply({ label: 'conflict', filename: manual.filename });
    await write(wednesday);
    const [pending] = await pendingFiles();
    const { entries } = await listUnifiedMemoryEntries(repo);
    const id = entries.find((e) => e.source.filePath === pending)!.id;
    await batchReviewMemoryEntries(repo, { entryIds: [id], decision: 'approve' });
    expect(await readMemoryFile(manual.filename)).toMatchObject({ status: 'archived', deprecatedBy: pending, content: original });
    expect(await readMemoryFile(pending)).toMatchObject({ status: 'active' });
  });
});
