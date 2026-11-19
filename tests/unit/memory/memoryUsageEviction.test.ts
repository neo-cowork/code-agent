// N-MEM-CITEBACK-RANK-EVICT 验收 ①–④：
// 真 SQLite（:memory: + 真 schema + 真 MemoryRepository）+ 固定时钟（vi.useFakeTimers），
// 主断言全部穿过 buildPackedSeedMemory / 真 MemoryRead / 真搜索通道，packer 不 mock。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../src/host/protocol/tools';
import type { MemoryRecord } from '../../../src/host/protocol/types/repositories';

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.unmock('better-sqlite3');

vi.mock('../../../src/host/services/core/database/nativeLoader', async () => {
  const module = await import('better-sqlite3');
  return {
    loadBetterSqlite3: () => module.default,
  };
});

vi.mock('../../../src/host/services/core/databaseService', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/services/core/databaseService')>(
    '../../../src/host/services/core/databaseService',
  );
  return {
    ...actual,
    getDatabase: () => {
      if (!dbHolder.current) throw new Error('Database not initialized');
      return dbHolder.current as ReturnType<typeof actual.getDatabase>;
    },
  };
});

vi.mock('../../../src/host/services/infra/logger', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/services/infra/logger')>(
    '../../../src/host/services/infra/logger',
  );
  return { ...actual, createLogger: () => loggerMock };
});

// 整理（consolidateLightMemory）的 quick model 在单测里不出网：直接判失败路径，
// 审计行照写（flaggedSources 断言与模型成败无关）。
vi.mock('../../../src/host/model/quickModel', () => ({
  memoryTask: vi.fn(async () => ({ success: false, error: 'memory model not configured in test' })),
}));

import Database from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { MemoryRepository } from '../../../src/host/services/core/repositories/MemoryRepository';
import { memoryEntryMetadata } from '../../../src/host/memory/memoryEntryMetadata';
import {
  listUnifiedMemoryEntries,
  packMemoryEntries,
  rebuildMemoryMirrorFromLightFiles,
  storedMemoryToEntry,
} from '../../../src/host/memory/memoryEntryRuntime';
import { memoryInjectionPauses, resumeMemoryInjection } from '../../../src/host/memory/memoryUsageEviction';
import {
  clearMemoryInjectionFlag,
  flagMemoryInjection,
  memoryUserFlagCounts,
  readInjectionFeedback,
} from '../../../src/host/memory/memoryInjectionFeedback';
import { buildPackedSeedMemory, buildSeedMemoryBlock } from '../../../src/host/utils/seedMemoryInjector';
import { consolidateLightMemory } from '../../../src/host/lightMemory/consolidation';
import { memoryReadModule } from '../../../src/host/tools/modules/lightMemory/memoryRead';
import { memorySearchModule } from '../../../src/host/tools/modules/lightMemory/memorySearch';
import { MEMORY, MEMORY_CONSOLIDATION } from '../../../src/shared/constants';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 固定时钟：所有过期判定都相对这个时刻 */
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeToolLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

type DbWrapper = {
  isReady: boolean;
  listMemories: (options?: Parameters<MemoryRepository['listMemories']>[0]) => MemoryRecord[];
  getMemory: (id: string) => MemoryRecord | null;
  createMemory: (data: Parameters<MemoryRepository['createMemory']>[0]) => MemoryRecord;
  updateMemory: (id: string, updates: Partial<MemoryRecord>, journal?: Parameters<MemoryRepository['updateMemory']>[2]) => MemoryRecord | null;
  recordMemoryAccess: (id: string) => void;
  searchMemories: (query: string, options?: { limit?: number; applyDecay?: boolean }) => MemoryRecord[];
  findMemoryByEntryId: (entryId: string) => MemoryRecord | null;
  listMemoriesWithInjectionFeedback: () => MemoryRecord[];
};

let raw: Database.Database | null = null;
let repo: MemoryRepository | null = null;
let db: DbWrapper | null = null;
let seq = 0;

function currentDb(): DbWrapper {
  if (!db) throw new Error('db not initialized');
  return db;
}

function currentRepo(): MemoryRepository {
  if (!repo) throw new Error('repo not initialized');
  return repo;
}

function wrapRepo(repository: MemoryRepository): DbWrapper {
  return {
    isReady: true,
    listMemories: (options) => repository.listMemories(options ?? {}),
    getMemory: (id) => repository.getMemory(id),
    createMemory: (data) => repository.createMemory(data),
    updateMemory: (id, updates, journal) => repository.updateMemory(id, updates, journal),
    recordMemoryAccess: (id) => repository.recordMemoryAccess(id),
    searchMemories: (query, options) => repository.searchMemories(query, options ?? {}),
    findMemoryByEntryId: (entryId) => repository.findMemoryByEntryId(entryId),
    listMemoriesWithInjectionFeedback: () => repository.listMemoriesWithInjectionFeedback(),
  };
}

function lightFile(title: string, body: string, projectPath?: string): string {
  const frontmatter = [
    '---',
    `name: ${title}`,
    `description: fixture ${title}`,
    'type: user',
    ...(projectPath ? [`project_path: ${projectPath}`] : []),
    '---',
  ];
  return `${frontmatter.join('\n')}\n\n${body}\n`;
}

let dataDir = '';
let memDir = '';

async function mirrorEntry(
  prefix: string,
  token: string,
  projectPath?: string,
): Promise<{ filename: string; rowId: string; entryId: string }> {
  seq += 1;
  const filename = `${prefix}-${seq}.md`;
  await fs.writeFile(path.join(memDir, filename), lightFile(filename, `${prefix} body ${token}`, projectPath), 'utf8');
  const rebuilt = await rebuildMemoryMirrorFromLightFiles(currentDb());
  expect(rebuilt.skipped).toEqual([]);
  const row = currentDb()
    .listMemories({ includeArchived: true, includeCandidates: true, limit: 1000, orderBy: 'updated_at', orderDir: 'DESC' })
    .find((memory) => memoryEntryMetadata(memory)?.filePath === filename);
  if (!row) throw new Error(`mirror row missing for ${filename}`);
  return { filename, rowId: row.id, entryId: storedMemoryToEntry(row).id };
}

function setUsage(rowId: string, accessCount: number, lastAccessedAt: number | null): void {
  if (!raw) throw new Error('db not initialized');
  raw.prepare('UPDATE memories SET access_count = ?, last_accessed_at = ? WHERE id = ?')
    .run(accessCount, lastAccessedAt, rowId);
}

function backdate(rowId: string, ts: number): void {
  if (!raw) throw new Error('db not initialized');
  raw.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, rowId);
}

/**
 * r2 窗口挤出回归：往库里塞 N 条 archived 垃圾行（不进注入，但占满 updated_at 最新 N 行的
 * 扫描窗口），把目标行挤出「最新 500 行」。archived 保证垃圾只影响窗口、不影响注入断言。
 */
function pushJunkRows(count: number): void {
  for (let i = 0; i < count; i += 1) {
    currentDb().createMemory({
      type: 'user_preference',
      category: 'fact',
      content: `window-junk-${i}`,
      source: 'session_extracted',
      confidence: 0.5,
      metadata: {},
      status: 'archived',
      deprecatedBy: null,
    });
  }
}

/** 坐实目标行不在「updated_at 最新 500 行」窗口里（负反馈旧实现只扫这个窗口）。 */
function assertOutsideScanWindow(rowId: string): void {
  const window = currentDb().listMemories({
    includeArchived: true, includeCandidates: true, limit: 500, orderBy: 'updated_at', orderDir: 'DESC',
  });
  expect(window).toHaveLength(500);
  expect(window.some((row) => row.id === rowId)).toBe(false);
}

async function injectedEntryIds(options?: { excludeEntryIds?: string[] }): Promise<string[]> {
  const packed = await buildPackedSeedMemory(options ?? {});
  expect(packed).not.toBeNull();
  return (packed?.packed.items ?? []).map((item) => item.entryId);
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: dataDir,
    abortSignal: ctrl.signal,
    logger: makeToolLogger(),
    emit: () => undefined,
    ...overrides,
  };
}

async function executeRead(args: Record<string, unknown>, ctx: ToolContext, permit: CanUseToolFn = allowAll) {
  const handler = await memoryReadModule.createHandler();
  return handler.execute(args, ctx, permit);
}

describe('memoryUsageEviction（seed 注入用量淘汰）', () => {
  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-evict-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    memDir = path.join(dataDir, 'memory');
    await fs.mkdir(memDir, { recursive: true });
  });

  afterAll(async () => {
    delete process.env.CODE_AGENT_DATA_DIR;
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // 每个用例一套全新 :memory: 库 + 干净的 light memory 目录，互相不串
    for (const entry of await fs.readdir(memDir)) {
      await fs.rm(path.join(memDir, entry), { recursive: true, force: true });
    }
    raw = new Database(':memory:');
    applySchema(raw, loggerMock as unknown as Parameters<typeof applySchema>[1]);
    repo = new MemoryRepository(raw);
    db = wrapRepo(repo);
    dbHolder.current = db;
  });

  afterEach(() => {
    vi.useRealTimers();
    dbHolder.current = null;
    db = null;
    repo = null;
    raw?.close();
    raw = null;
  });

  it('① 用过且 >30 天未再用：不进注入块，但 MemoryRead/搜索照常返回、行未删', async () => {
    vi.useFakeTimers({ now: NOW });
    const stale = await mirrorEntry('stale', 'zirceanstale');
    const fresh = await mirrorEntry('fresh', 'zirceanfresh');
    const never = await mirrorEntry('never', 'zirceannever');
    setUsage(stale.rowId, 3, NOW - 40 * DAY_MS);
    setUsage(fresh.rowId, 2, NOW - 5 * DAY_MS);
    setUsage(never.rowId, 0, null);

    const ids = await injectedEntryIds();
    expect(ids).toContain(fresh.entryId);
    expect(ids).toContain(never.entryId);
    expect(ids).not.toContain(stale.entryId);

    // 行未删、统一入口仍列出
    expect(currentDb().getMemory(stale.rowId)?.content).toContain('zirceanstale');
    const unified = await listUnifiedMemoryEntries(currentDb());
    expect(unified.entries.map((entry) => entry.id)).toContain(stale.entryId);

    // MemoryRead 照常可读（不因淘汰被挡）
    const read = await executeRead({ filename: stale.filename }, makeCtx({ runId: 'run-stale' }));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.output).toContain('zirceanstale');

    // 搜索照常返回（结果按文件名列出，计数为 1 = 只命中这条）
    const searchHandler = await memorySearchModule.createHandler();
    const searched = await searchHandler.execute({ query: 'zirceanstale' }, makeCtx(), allowAll);
    expect(searched.ok).toBe(true);
    if (searched.ok) {
      expect(searched.output).toContain(stale.filename);
      expect(searched.meta?.count).toBe(1);
    }
  });

  it('② 从未用过（含很老的）/ 30 天内用过 / 恰好 30 天边界 / 有次数无时间戳：照常注入', async () => {
    vi.useFakeTimers({ now: NOW });
    const neverOld = await mirrorEntry('neverold', 'zircebneverold');
    const fresh = await mirrorEntry('freshwin', 'zircebfreshwin');
    const boundary = await mirrorEntry('boundary', 'zircebboundary');
    const noStamp = await mirrorEntry('nostamp', 'zircebnostamp');
    setUsage(neverOld.rowId, 0, null);
    backdate(neverOld.rowId, NOW - 400 * DAY_MS);
    setUsage(fresh.rowId, 1, NOW - 5 * DAY_MS);
    setUsage(boundary.rowId, 2, NOW - MEMORY.SEED_STALE_USED_MS);
    setUsage(noStamp.rowId, 5, null);
    // 有次数无时间戳 + 行本身很老：仍不淘汰（不回落 updatedAt）
    backdate(noStamp.rowId, NOW - 400 * DAY_MS);

    const ids = await injectedEntryIds();
    expect(ids).toContain(neverOld.entryId);
    expect(ids).toContain(fresh.entryId);
    expect(ids).toContain(boundary.entryId);
    expect(ids).toContain(noStamp.entryId);
  });

  it('③ day one（存量记忆全部未用过）注入集合与改动前完全一致', async () => {
    vi.useFakeTimers({ now: NOW });
    const a = await mirrorEntry('dayone-a', 'zircedayonea');
    const b = await mirrorEntry('dayone-b', 'zircedayoneb');
    const c = await mirrorEntry('dayone-c', 'zircedayonec');
    for (const entry of [a, b, c]) setUsage(entry.rowId, 0, null);
    backdate(c.rowId, NOW - 400 * DAY_MS);

    const injectorIds = await injectedEntryIds();
    expect(injectorIds.length).toBeGreaterThan(0);

    // 改动前行为 = 以同样参数直接调 packer（不经用量淘汰）；集合必须逐条一致
    const before = await packMemoryEntries({
      statuses: ['active'],
      kinds: ['user', 'feedback', 'project', 'reference', 'session', 'pattern'],
      maxItems: 10,
      perItemCharLimit: 120,
      totalCharBudget: 800,
    }, currentDb());
    const beforeIds = before.items.map((item) => item.entryId);
    expect(injectorIds).toEqual(beforeIds);
  });

  it('调用方 excludeEntryIds 与用量淘汰取并集', async () => {
    vi.useFakeTimers({ now: NOW });
    const stale = await mirrorEntry('union-stale', 'zirceunionstale');
    const fresh = await mirrorEntry('union-fresh', 'zirceunionfresh');
    const keeper = await mirrorEntry('union-keep', 'zirceunionkeep');
    setUsage(stale.rowId, 3, NOW - 40 * DAY_MS);
    setUsage(fresh.rowId, 1, NOW - 3 * DAY_MS);
    setUsage(keeper.rowId, 0, null);

    const ids = await injectedEntryIds({ excludeEntryIds: [fresh.entryId] });
    // keeper 在场证明打包本身成功了，两条排除不是「整体为空」的假绿
    expect(ids).toContain(keeper.entryId);
    expect(ids).not.toContain(fresh.entryId);
    expect(ids).not.toContain(stale.entryId);
  });

  it('④ 用量扫描出错时 fail-open：注入照常进行，不淘汰任何条目', async () => {
    vi.useFakeTimers({ now: NOW });
    const entry = await mirrorEntry('failopen', 'zircefailopen');
    setUsage(entry.rowId, 4, NOW - 60 * DAY_MS);

    // 直接单元断言：抛错的 db → 空集合 + warn 带原因
    const throwing = {
      listMemories: () => {
        throw new Error('boom scan');
      },
    } as unknown as Parameters<typeof memoryInjectionPauses>[0];
    expect(memoryInjectionPauses(throwing, NOW).size).toBe(0);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '[MemoryUsageEviction] usage scan failed, injecting without eviction',
      expect.objectContaining({ error: expect.stringContaining('boom scan') }),
    );
    expect(memoryInjectionPauses(undefined, NOW).size).toBe(0);

    // 端到端：扫描抛错（第一次 listMemories）不拖垮注入，条目照常注入
    let calls = 0;
    db = {
      ...currentDb(),
      listMemories: (options) => {
        calls += 1;
        if (calls === 1) throw new Error('boom scan');
        return currentRepo().listMemories(options ?? {});
      },
    };
    dbHolder.current = db;
    const ids = await injectedEntryIds();
    expect(ids).toContain(entry.entryId);
  });

  // ---- N-MEM-EVICT-NEVER-READ：从没被 MemoryRead 用过的也按宽限期老化（爸 10-14 定 B）----
  const LAUNCH = MEMORY.NEVER_USED_EVICTION_SINCE;
  const GRACE = MEMORY.SEED_NEVER_USED_GRACE_MS;

  it('从没用过：自上线日起过了宽限期退出注入；行仍在、MemoryRead 照常可读', async () => {
    const later = LAUNCH + GRACE + DAY_MS;
    vi.useFakeTimers({ now: later });
    const neverOld = await mirrorEntry('nr-old', 'zircfneverold');
    const used = await mirrorEntry('nr-used', 'zircfused');
    setUsage(neverOld.rowId, 0, null);
    backdate(neverOld.rowId, LAUNCH - 400 * DAY_MS);
    setUsage(used.rowId, 1, later - 2 * DAY_MS);
    backdate(used.rowId, LAUNCH - 400 * DAY_MS);

    const ids = await injectedEntryIds();
    expect(ids).toContain(used.entryId);
    expect(ids).not.toContain(neverOld.entryId);
    expect(memoryInjectionPauses(currentDb(), later).get(neverOld.entryId)).toEqual({ reason: 'never_used', since: LAUNCH + GRACE });

    const read = await executeRead({ filename: neverOld.filename }, makeCtx({ runId: 'run-never-old' }));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.output).toContain('zircfneverold');
  });

  it('从没用过：宽限期从创建时间与上线日中较晚者起算；宽限期内与边界照常注入', async () => {
    const now = LAUNCH + GRACE + 10 * DAY_MS;
    vi.useFakeTimers({ now });
    const recent = await mirrorEntry('nr-recent', 'zircfrecent');
    const boundary = await mirrorEntry('nr-boundary', 'zircfboundary');
    setUsage(recent.rowId, 0, null);
    backdate(recent.rowId, now - 5 * DAY_MS);
    setUsage(boundary.rowId, 0, null);
    backdate(boundary.rowId, now - GRACE);

    const ids = await injectedEntryIds();
    expect(ids).toContain(recent.entryId);
    expect(ids).toContain(boundary.entryId);
  });

  it('上线当天到宽限期满之前：存量从没用过的记忆一条都不淘汰', async () => {
    vi.useFakeTimers({ now: LAUNCH + GRACE - DAY_MS });
    const old = await mirrorEntry('nr-launch', 'zircflaunch');
    setUsage(old.rowId, 0, null);
    backdate(old.rowId, LAUNCH - 900 * DAY_MS);
    expect(memoryInjectionPauses(currentDb(), Date.now()).size).toBe(0);
    expect(await injectedEntryIds()).toContain(old.entryId);
  });

  it('恢复自动注入：记一次使用后回到注入集合；找不到的条目返回 false', async () => {
    const later = LAUNCH + GRACE + DAY_MS;
    vi.useFakeTimers({ now: later });
    const paused = await mirrorEntry('nr-resume', 'zircfresume');
    const keeper = await mirrorEntry('nr-keeper', 'zircfkeeper');
    setUsage(keeper.rowId, 1, later - DAY_MS);
    setUsage(paused.rowId, 0, null);
    backdate(paused.rowId, LAUNCH - 400 * DAY_MS);
    expect(await injectedEntryIds()).not.toContain(paused.entryId);

    expect(resumeMemoryInjection(currentDb(), paused.entryId)).toBe(true);
    expect(memoryInjectionPauses(currentDb(), later).has(paused.entryId)).toBe(false);
    expect(await injectedEntryIds()).toContain(paused.entryId);
    expect(resumeMemoryInjection(currentDb(), 'no-such-entry')).toBe(false);
  });

  // ---- N-MEM-EVICT-NEVER-READ-FU1：fallback buildSeedMemoryBlock 同口径排除已暂停记忆 ----
  // bootstrap（conversationRuntimeContextBootstrap.injectSeedMemory）顺序：packed 返回 null
  // 时落到 buildSeedMemoryBlock(projectPath)。项目级记忆经 light 文件 frontmatter 的
  // project_path 落库，断言全走真实 DB + 两条注入通道。
  const PROJ = '/repo/paused-fu1-proj';

  it('fallback ①：项目记忆全部暂停时 packed 与 fallback 都返回 null（按 bootstrap 先后顺序断言）', async () => {
    const later = LAUNCH + GRACE + DAY_MS;
    vi.useFakeTimers({ now: later });
    const stale = await mirrorEntry('fb-stale', 'zircgfbstale', PROJ);
    const never = await mirrorEntry('fb-never', 'zircgfbnever', PROJ);
    setUsage(stale.rowId, 3, later - 40 * DAY_MS);
    setUsage(never.rowId, 0, null);
    backdate(never.rowId, LAUNCH - 400 * DAY_MS);

    // 两条确实都在暂停集合（一 stale_used 一 never_used），排除「整体为空」的假绿
    const pauses = memoryInjectionPauses(currentDb(), later);
    expect(pauses.get(stale.entryId)?.reason).toBe('stale_used');
    expect(pauses.get(never.entryId)?.reason).toBe('never_used');

    // bootstrap 先 packed（全排除 → null），再 fallback（不得把暂停记忆回流 → null）
    await expect(buildPackedSeedMemory({ projectPath: PROJ })).resolves.toBeNull();
    expect(buildSeedMemoryBlock(PROJ)).toBeNull();
  });

  it('fallback ②：混合时块非空——含未暂停的新鲜记忆、不含暂停记忆', async () => {
    const later = LAUNCH + GRACE + DAY_MS;
    vi.useFakeTimers({ now: later });
    const paused = await mirrorEntry('fb-paused', 'zircgfbpaused', PROJ);
    const fresh = await mirrorEntry('fb-fresh', 'zircgfbfresh', PROJ);
    setUsage(paused.rowId, 0, null);
    backdate(paused.rowId, LAUNCH - 400 * DAY_MS);
    setUsage(fresh.rowId, 1, later - 2 * DAY_MS);
    backdate(fresh.rowId, LAUNCH - 400 * DAY_MS);

    const block = buildSeedMemoryBlock(PROJ);
    expect(block).not.toBeNull();
    expect(block).toContain('## Stored Memories');
    // [#行id] 是 fallback 每条记忆的稳定句柄（formatMemoryEntry），用它区分「注入了谁」
    expect(block).toContain(`[#${fresh.rowId}]`);
    expect(block).not.toContain(`[#${paused.rowId}]`);
  });

  it('fallback ③：resumeMemoryInjection 后该记忆重新回到 fallback 块', async () => {
    const later = LAUNCH + GRACE + DAY_MS;
    vi.useFakeTimers({ now: later });
    const paused = await mirrorEntry('fb-resume', 'zircgfbresume', PROJ);
    const keeper = await mirrorEntry('fb-keeper', 'zircgfbkeeper', PROJ);
    setUsage(paused.rowId, 0, null);
    backdate(paused.rowId, LAUNCH - 400 * DAY_MS);
    setUsage(keeper.rowId, 1, later - DAY_MS);
    backdate(keeper.rowId, LAUNCH - 400 * DAY_MS);

    const before = buildSeedMemoryBlock(PROJ);
    expect(before).not.toBeNull();
    expect(before).toContain(`[#${keeper.rowId}]`);
    expect(before).not.toContain(`[#${paused.rowId}]`);

    expect(resumeMemoryInjection(currentDb(), paused.entryId)).toBe(true);
    const after = buildSeedMemoryBlock(PROJ);
    expect(after).not.toBeNull();
    expect(after).toContain(`[#${paused.rowId}]`);
  });

  // ---- N-MEM-SOURCE-WRONG-FEEDBACK：回复下方「不对 / 过时了」负反馈 ----
  // 全部走真实 SQLite + flagMemoryInjection / clearMemoryInjectionFlag 公共入口 +
  // buildPackedSeedMemory / buildSeedMemoryBlock 两条注入通道，无手搓替身。
  describe('user flag（不对/过时了）', () => {
    it('⑤ 标记 → 下一轮不再注入（packed 与 fallback 两通道）→ 撤销 → 重新注入；撤销不动 access_count', async () => {
      vi.useFakeTimers({ now: NOW });
      const flagged = await mirrorEntry('uf-flag', 'zirchufflag');
      const keeper = await mirrorEntry('uf-keep', 'zirchufkeep');
      setUsage(flagged.rowId, 2, NOW - 3 * DAY_MS);
      setUsage(keeper.rowId, 1, NOW - 3 * DAY_MS);
      const accessBefore = currentDb().getMemory(flagged.rowId)?.accessCount;

      // 标记前两条都在
      expect(await injectedEntryIds()).toEqual(expect.arrayContaining([flagged.entryId, keeper.entryId]));

      expect(await flagMemoryInjection(currentDb(), flagged.entryId, 'wrong')).toBe(true);
      expect(memoryInjectionPauses(currentDb(), NOW).get(flagged.entryId)).toMatchObject({ reason: 'user_wrong' });

      // packed 通道：标记的条目不再注入（keeper 在场排除「整体为空」假绿）
      const afterFlag = await injectedEntryIds();
      expect(afterFlag).toContain(keeper.entryId);
      expect(afterFlag).not.toContain(flagged.entryId);

      // fallback 通道（项目记忆混合时：标记的不回流，未标记的照常在）
      const projFlagged = await mirrorEntry('uf-proj', 'zirchufproj', PROJ);
      const projKeeper = await mirrorEntry('uf-projk', 'zirchufprojk', PROJ);
      expect(buildSeedMemoryBlock(PROJ)).toContain(`[#${projFlagged.rowId}]`);
      expect(await flagMemoryInjection(currentDb(), projFlagged.entryId, 'outdated')).toBe(true);
      const projBlock = buildSeedMemoryBlock(PROJ);
      expect(projBlock).not.toContain(`[#${projFlagged.rowId}]`);
      expect(projBlock).toContain(`[#${projKeeper.rowId}]`);
      expect(memoryInjectionPauses(currentDb(), NOW).get(projFlagged.entryId)).toMatchObject({ reason: 'user_outdated' });

      // 撤销 → 重新注入；access_count 与标记前一致（撤销绝不记使用）
      expect(clearMemoryInjectionFlag(currentDb(), flagged.entryId)).toBe(true);
      expect(await injectedEntryIds()).toContain(flagged.entryId);
      expect(currentDb().getMemory(flagged.rowId)?.accessCount).toBe(accessBefore);
      // 幂等：没有标记时撤销返回 false
      expect(clearMemoryInjectionFlag(currentDb(), flagged.entryId)).toBe(false);
    });

    it('user_* 优先于用量原因：stale_used 的行被标记后暂停原因变成 user_wrong', async () => {
      vi.useFakeTimers({ now: NOW });
      const stale = await mirrorEntry('uf-stale', 'zirchufstale');
      setUsage(stale.rowId, 3, NOW - 40 * DAY_MS);
      expect(memoryInjectionPauses(currentDb(), NOW).get(stale.entryId)).toMatchObject({ reason: 'stale_used' });
      expect(await flagMemoryInjection(currentDb(), stale.entryId, 'wrong')).toBe(true);
      expect(memoryInjectionPauses(currentDb(), NOW).get(stale.entryId)).toMatchObject({ reason: 'user_wrong' });
    });

    it('④ 负反馈计数累计在 metadata（撤销不清零），MemoryRead/搜索照常返回', async () => {
      vi.useFakeTimers({ now: NOW });
      const flagged = await mirrorEntry('uf-count', 'zirchufcount');
      await flagMemoryInjection(currentDb(), flagged.entryId, 'wrong', NOW);
      await flagMemoryInjection(currentDb(), flagged.entryId, 'outdated', NOW + 1000);
      expect(readInjectionFeedback(currentDb().getMemory(flagged.rowId)?.metadata)).toEqual({
        kind: 'outdated', at: NOW + 1000, count: 2,
      });
      expect(memoryUserFlagCounts(currentDb()).get(flagged.entryId)).toBe(2);

      expect(clearMemoryInjectionFlag(currentDb(), flagged.entryId)).toBe(true);
      // 撤销后：不再暂停、计数保留
      expect(memoryInjectionPauses(currentDb(), NOW).has(flagged.entryId)).toBe(false);
      expect(readInjectionFeedback(currentDb().getMemory(flagged.rowId)?.metadata)).toEqual({ count: 2 });
      expect(memoryUserFlagCounts(currentDb()).get(flagged.entryId)).toBe(2);

      // MemoryRead / 搜索不受标记影响（与用量暂停同口径）
      await flagMemoryInjection(currentDb(), flagged.entryId, 'wrong', NOW);
      const read = await executeRead({ filename: flagged.filename }, makeCtx({ runId: 'run-uf' }));
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.output).toContain('zirchufcount');
      const searchHandler = await memorySearchModule.createHandler();
      const searched = await searchHandler.execute({ query: 'zirchufcount' }, makeCtx(), allowAll);
      expect(searched.ok).toBe(true);
      if (searched.ok) expect(searched.output).toContain(flagged.filename);
    });

    it('④ 标记与撤销都落变更日志（actor=user_manual）；找不到的条目返回 false', async () => {
      vi.useFakeTimers({ now: NOW });
      const flagged = await mirrorEntry('uf-journal', 'zirchufjournal');
      await flagMemoryInjection(currentDb(), flagged.entryId, 'wrong', NOW);
      clearMemoryInjectionFlag(currentDb(), flagged.entryId);
      const journal = currentRepo().listMemoryJournal({ entryId: flagged.entryId });
      // create（镜像行）+ flag + clear = 至少 3 行，后两行 actor 都是 user_manual
      const manual = journal.filter((row) => row.actor === 'user_manual');
      expect(manual.length).toBeGreaterThanOrEqual(2);
      expect(manual[0].operation).toBe('update');
      expect(await flagMemoryInjection(currentDb(), 'no-such-entry', 'wrong')).toBe(false);
      expect(clearMemoryInjectionFlag(currentDb(), 'no-such-entry')).toBe(false);
    });

    // ---- Rework r1：光文件无镜像行（MemoryWrite 主路径常态，用户从不手跑 rebuild）----
    // flag 必须自补镜像再落标记：注入立即停 + 整理审计 flaggedSources 点名该文件。
    it('r1 无镜像行的 light 条目：flag 自补镜像 → 注入停 + 整理审计 flaggedSources 点名', async () => {
      vi.useFakeTimers({ now: NOW });
      // 只写光文件，不 rebuild 镜像 —— 主用户路径常态
      const filename = 'no-mirror-flag.md';
      await fs.writeFile(path.join(memDir, filename), lightFile(filename, 'zirchnomirror'), 'utf-8');
      const keeperName = 'no-mirror-keep.md';
      await fs.writeFile(path.join(memDir, keeperName), lightFile(keeperName, 'zirchnomirrorkeep'), 'utf-8');
      const entryId = `light:${filename}`;
      // 前提坐实：DB 里一行镜像都没有
      expect(currentDb().listMemories({
        includeArchived: true, includeCandidates: true, limit: 1000, orderBy: 'updated_at', orderDir: 'DESC',
      })).toHaveLength(0);
      // 无镜像也在注入（packer 直读光文件）
      expect(await injectedEntryIds()).toContain(entryId);

      // 公共入口：无镜像行也要标记上（自补镜像），不再返回 false
      expect(await flagMemoryInjection(currentDb(), entryId, 'wrong')).toBe(true);
      expect(memoryInjectionPauses(currentDb(), NOW).get(entryId)).toMatchObject({ reason: 'user_wrong' });
      const afterFlag = await injectedEntryIds();
      expect(afterFlag).not.toContain(entryId);

      // 整理侧同源：审计行 flaggedSources 含该文件（模型 mock 为失败路径，审计照写）
      const report = await consolidateLightMemory({ dryRun: false, workingDirectory: dataDir, db: currentDb() });
      expect(report.triggered).toBe(true);
      const auditLines = (await fs.readFile(
        path.join(memDir, MEMORY_CONSOLIDATION.AUDIT_FILENAME), 'utf-8',
      )).trim().split('\n');
      const flaggedRows = auditLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((row) => Array.isArray(row.flaggedSources) && (row.flaggedSources as string[]).includes(filename));
      expect(flaggedRows.length).toBeGreaterThan(0);
    });

    // ---- Rework r2：负反馈不得依赖「updated_at 最新 500 行」扫描窗口 ----
    // ai-review：窗口外的镜像行 flag 恒失败；标记成功的行被 500 条更新行挤出窗口后
    // 暂停扫描看不见 kind，光文件重新被注入。两条回归都在真 SQLite 上复刻窗口挤出。
    it('r2 镜像行被挤出最新 500 行窗口：flag 仍成功（直查不扫窗口），注入照停', async () => {
      vi.useFakeTimers({ now: NOW });
      const target = await mirrorEntry('w2-old', 'zirchw2old');
      const keeper = await mirrorEntry('w2-keep', 'zirchw2keep');
      backdate(target.rowId, NOW - 90 * DAY_MS);
      // 窗口内仍注入（光文件直读，不经窗口）
      expect(await injectedEntryIds()).toContain(target.entryId);

      pushJunkRows(600);
      assertOutsideScanWindow(target.rowId);

      // 窗口外的行也要标记得上（r2 修复前：findRow 只扫最新 500 行 → false）
      expect(await flagMemoryInjection(currentDb(), target.entryId, 'wrong')).toBe(true);
      expect(memoryInjectionPauses(currentDb(), NOW).get(target.entryId)).toMatchObject({ reason: 'user_wrong' });
      const afterFlag = await injectedEntryIds();
      expect(afterFlag).not.toContain(target.entryId);
      expect(afterFlag).toContain(keeper.entryId);
    });

    it('r2 标记成功后被 600 条更新行挤出窗口：暂停不丢、不重新注入、计数仍在', async () => {
      vi.useFakeTimers({ now: NOW });
      const target = await mirrorEntry('w2-evict', 'zirchw2evict');
      const keeper = await mirrorEntry('w2-keep2', 'zirchw2keep2');
      expect(await flagMemoryInjection(currentDb(), target.entryId, 'outdated')).toBe(true);
      expect((await injectedEntryIds())).not.toContain(target.entryId);

      // 标记之后又写进 600 条更新的行（垃圾行 archived：不进注入，只占窗口）
      vi.setSystemTime(NOW + 60 * DAY_MS);
      pushJunkRows(600);
      assertOutsideScanWindow(target.rowId);

      // 暂停必须还在（r2 修复前：窗口扫描看不见 kind → 光文件重新被注入）
      expect(memoryInjectionPauses(currentDb(), NOW).get(target.entryId)).toMatchObject({ reason: 'user_outdated' });
      const afterPush = await injectedEntryIds();
      expect(afterPush).not.toContain(target.entryId);
      expect(afterPush).toContain(keeper.entryId);
      // 设置侧「被标记过 N 次」同一窗口问题（同类位置）：计数不丢
      expect(memoryUserFlagCounts(currentDb()).get(target.entryId)).toBe(1);
    });
  });
});
