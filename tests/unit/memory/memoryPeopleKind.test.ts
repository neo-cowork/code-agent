// N-MEM-CATEGORY-PEOPLE-PROJECT：memory kind `people`（人与组织）端到端——
// 各写入路径经生产入口落盘、敏感串脱敏、导出导入往返、旧类型文件不被改写。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { MemoryRecord } from '../../../src/host/services/core/repositories';
import type { MemoryExportV2Bundle } from '../../../src/shared/contract/memory';
import type { ToolContext, Logger } from '../../../src/host/protocol/tools';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/host/config/configPaths', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/config/configPaths')>(),
  getUserConfigDir: () => mockConfigDir.dir,
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  applyImportMemoryBundleV2,
  dryRunImportMemoryBundleV2,
  exportMemoryBundleV2,
  listUnifiedMemoryEntries,
  deleteMemoryEntry,
} from '../../../src/host/memory/memoryEntryRuntime';
import { createManualMemoryEntry } from '../../../src/host/memory/memoryEntryCreate';
import { writeDurableFacts } from '../../../src/host/lightMemory/durableFactWriter';
import { memoryWriteModule } from '../../../src/host/tools/modules/lightMemory/memoryWrite';

const CARD = '4111111111111111';
const PASSWORD_LINE = 'password: Hunter2-Zebra-77';
const SECRET_TEXT = `银行卡 ${CARD}，${PASSWORD_LINE}`;

function fakeDb() {
  const rows: MemoryRecord[] = [];
  return {
    rows,
    listMemories: vi.fn(() => rows),
    createMemory: vi.fn((data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>) => {
      const next = {
        id: `mem-${rows.length + 1}`, ...data, accessCount: 0, createdAt: 1, updatedAt: 1,
      } as MemoryRecord;
      rows.push(next);
      return next;
    }),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn(),
  };
}

function ctx(): ToolContext {
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    sessionId: 's', workingDir: process.cwd(), abortSignal: new AbortController().signal,
    logger, emit: () => void 0,
    directiveMemoryWriteGrant: { authority: 'directive-memory-write', fingerprint: 'unit-test', requestId: 'r1', confirmedAt: 1 },
  } as ToolContext;
}

async function readAllMemoryText(memDir: string): Promise<string> {
  const names = await fs.readdir(memDir);
  const texts = await Promise.all(names.map((n) => fs.readFile(path.join(memDir, n), 'utf-8')));
  return texts.join('\n');
}

describe('memory kind people', () => {
  let tmpDir: string;
  let memDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-people-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
    await fs.mkdir(memDir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('MemoryWrite stores type people as a global people entry and redacts card/password', async () => {
    const handler = await memoryWriteModule.createHandler();
    const result = await handler.execute({
      action: 'write', filename: 'zhangsan.md', name: '张三', description: '设计，负责会员页改版',
      type: 'people', content: `张三是设计，负责会员页改版。${SECRET_TEXT}`,
    }, ctx(), async () => ({ allow: true }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const raw = await fs.readFile(path.join(memDir, 'zhangsan.md'), 'utf-8');
    expect(raw).toContain('type: people');
    expect(raw).toContain('张三是设计');
    expect(raw).not.toContain(CARD);
    expect(raw).not.toContain('Hunter2-Zebra-77');

    const { entries } = await listUnifiedMemoryEntries(fakeDb());
    expect(entries.find((e) => e.source.filePath === 'zhangsan.md')).toMatchObject({ kind: 'people', scope: 'global' });
  });

  it('writeDurableFacts accepts type people and redacts card/password', async () => {
    const result = await writeDurableFacts([{
      filename: 'lisi.md', name: '李四', description: '会员页前端负责人', type: 'people',
      content: `李四是前端，负责会员页。${SECRET_TEXT}`, confidence: 0.9,
    }]);
    expect(result.written).toBe(1);
    const raw = await fs.readFile(path.join(memDir, 'lisi.md'), 'utf-8');
    expect(raw).toContain('type: people');
    expect(raw).not.toContain(CARD);
    expect(raw).not.toContain('Hunter2-Zebra-77');
  });

  it('manual add accepts people (global scope), redacts card/password in file and DB mirror, and entry can be deleted', async () => {
    const db = fakeDb();
    const created = await createManualMemoryEntry(db, {
      kind: 'people', content: `王五是客户方对接人。${SECRET_TEXT}`,
    }, { actor: 'user_manual' } as never);
    expect(created.created).toBe(true);
    expect(created.entry).toMatchObject({ kind: 'people', scope: 'global' });
    expect(await readAllMemoryText(memDir)).toContain('type: people');
    expect(await readAllMemoryText(memDir)).not.toContain(CARD);
    expect(JSON.stringify(db.rows)).not.toContain(CARD);
    expect(JSON.stringify(db.rows)).not.toContain('Hunter2-Zebra-77');

    const before = (await listUnifiedMemoryEntries(db)).entries.filter((e) => e.kind === 'people');
    expect(before).toHaveLength(1);
    await deleteMemoryEntry(db, { entryId: before[0].id });
    const after = (await listUnifiedMemoryEntries(db)).entries.filter((e) => e.kind === 'people' && e.status === 'active');
    expect(after).toHaveLength(0);
  });

  it('bundle import redacts card/password for kind people', async () => {
    const db = fakeDb();
    const bundle: MemoryExportV2Bundle = {
      schemaVersion: 2, exportedAt: 1,
      entries: [{
        id: 'mem_people_import', schemaVersion: 2, status: 'active', kind: 'people', scope: 'global',
        title: '赵六', summary: '供应商联系人', content: `赵六负责供应。${SECRET_TEXT}`,
        source: { kind: 'import', sourceOfTruth: 'light_file', filePath: 'zhaoliu.md', label: 'test' },
        evidence: [], projectPath: null, sessionId: null, confidence: 1, createdAt: 1, updatedAt: 1,
      }],
      index: { path: '/tmp/INDEX.md', content: null }, evidenceManifest: [],
      sourceCounts: { light_file: 1, db_memory: 0 },
    };
    await applyImportMemoryBundleV2(bundle, db);
    const raw = await fs.readFile(path.join(memDir, 'zhaoliu.md'), 'utf-8');
    expect(raw).toContain('type: people');
    expect(raw).not.toContain(CARD);
    expect(raw).not.toContain('Hunter2-Zebra-77');
  });

  it('keeps old-type files byte-identical, round-trips people through export→import, and still imports an old bundle', async () => {
    const oldFiles: Record<string, string> = {
      'pref.md': '---\nname: Pref\ndescription: reply style\ntype: user\nentry_id: mem_pref\nstatus: active\nschema_version: 2\n---\n\nShort answers.\n',
      'proj.md': '---\nname: Proj\ndescription: rule\ntype: project\nentry_id: mem_proj\nstatus: active\nschema_version: 2\n---\n\nUse patterns.\n',
    };
    for (const [n, t] of Object.entries(oldFiles)) await fs.writeFile(path.join(memDir, n), t, 'utf-8');
    const oldBundle = await exportMemoryBundleV2(fakeDb());
    expect(oldBundle.entries.map((e) => e.kind).sort()).toEqual(['project', 'user']);

    const db = fakeDb();
    await createManualMemoryEntry(db, { kind: 'people', content: '张三是设计，负责会员页改版' }, { actor: 'user_manual' } as never);
    for (const [n, t] of Object.entries(oldFiles)) expect(await fs.readFile(path.join(memDir, n), 'utf-8')).toBe(t);

    const bundle = await exportMemoryBundleV2(db);
    const people = bundle.entries.filter((e) => e.kind === 'people');
    expect(people).toHaveLength(1);

    // 新数据目录：导入（先 dry-run 再 apply）
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-people-target-'));
    try {
      mockConfigDir.dir = target;
      await fs.mkdir(path.join(target, 'memory'), { recursive: true });
      const targetDb = fakeDb();
      const dry = await dryRunImportMemoryBundleV2(bundle, targetDb);
      expect(dry.added).toBe(bundle.entries.length);
      const applied = await applyImportMemoryBundleV2(bundle, targetDb);
      expect(applied.applied).toBe(bundle.entries.length);
      const kinds = (await listUnifiedMemoryEntries(targetDb)).entries.map((e) => e.kind).sort();
      expect(kinds).toEqual(['people', 'project', 'user']);
      const again = await applyImportMemoryBundleV2(bundle, targetDb);
      expect(again.added).toBe(0);
      expect((await listUnifiedMemoryEntries(targetDb)).entries).toHaveLength(3);

      // 旧 bundle（无 people）仍可导入
      const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-people-legacy-'));
      mockConfigDir.dir = empty;
      await fs.mkdir(path.join(empty, 'memory'), { recursive: true });
      const legacy = await dryRunImportMemoryBundleV2(oldBundle, fakeDb());
      expect(legacy.added).toBe(2);
      await fs.rm(empty, { recursive: true, force: true });
    } finally {
      mockConfigDir.dir = tmpDir;
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});
