// ============================================================================
// N-FIX-SESSION-TITLE-REVERTS-TO-RAW-MESSAGE-FU1：智能标题 / 手动改名回写云端行
// 真 sqlite + 真 SessionManager.updateSession + 真 syncSupabaseSessionRow，
// 假 Supabase 客户端是带状态的内存表（upsert/ignoreDuplicates、update+select、拉取 select）。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const dbHolder = vi.hoisted(() => ({ current: null as DatabaseService | null }));
const cloud = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  initialized: true,
  user: { id: 'user-1' } as { id: string } | null,
  updateError: null as unknown,
}));
const warn = vi.hoisted(() => vi.fn());

vi.unmock('better-sqlite3');
vi.mock('../../../../src/host/services/core/database/nativeLoader', async () => {
  const module = await import('better-sqlite3');
  return { loadBetterSqlite3: () => module.default };
});
vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => {
    if (!dbHolder.current) throw new Error('Database not initialized');
    return dbHolder.current;
  },
}));
vi.mock('../../../../src/host/platform', () => ({
  AppWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => cloud.user }),
}));
vi.mock('../../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({ clearSession: vi.fn() }),
}));
vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({ ensureProjectForWorkspace: vi.fn().mockResolvedValue({ id: 'p' }) }),
}));

type Row = Record<string, unknown>;
function builder() {
  let op: 'select' | 'update' | 'upsert' | null = null;
  let payload: Row = {};
  let opts: { ignoreDuplicates?: boolean } = {};
  const filters: Record<string, unknown> = {};
  const run = () => {
    const matched = [...cloud.rows.values()].filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
    if (op === 'upsert') {
      const id = payload.id as string;
      if (!(cloud.rows.has(id) && opts.ignoreDuplicates)) cloud.rows.set(id, { ...cloud.rows.get(id), ...payload });
      return { data: null, error: null };
    }
    if (op === 'update') {
      if (cloud.updateError) return { data: null, error: cloud.updateError };
      matched.forEach((r) => Object.assign(r, payload));
      return { data: matched.map((r) => ({ id: r.id })), error: null };
    }
    return { data: matched.map((r) => ({ ...r })), error: null };
  };
  const b: Record<string, unknown> = {
    select: () => { op ??= 'select'; return b; },
    eq: (c: string, v: unknown) => { filters[c] = v; return b; },
    order: () => b,
    limit: () => Promise.resolve(run()),
    update: (v: Row) => { op = 'update'; payload = v; return b; },
    upsert: (v: Row, o?: { ignoreDuplicates?: boolean }) => { op = 'upsert'; payload = v; opts = o ?? {}; return b; },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
  };
  return b;
}
const fakeClient = { from: () => builder() };
vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => cloud.initialized,
  getSupabase: () => fakeClient,
}));

import { DatabaseService } from '../../../../src/host/services/core/databaseService';
import { syncSupabaseSessionRow } from '../../../../src/web/helpers/supabaseSessionSync';
import type { SupabaseAgentBinding } from '../../../../src/web/routes/agentRouteTypes';

const PROMPT = '我是第一次使用 Neo。请帮我写一份自我介绍并生成可打开查看的档案';
const TRUNCATED = `${PROMPT.slice(0, 30)}...`;
const SMART = '小星的自我介绍与第一份档案生成';
const SID = 'sess-push';
const sb = { supabase: fakeClient, userId: 'user-1' } as unknown as SupabaseAgentBinding;
const syncArgs = { sessionId: SID, isNewSession: true, title: TRUNCATED, provider: 'xiaomi', model: 'mimo' };

let dataDir = '';

async function createManager() {
  const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
  return new SessionManager();
}
const cloudTitle = () => cloud.rows.get(SID)?.title;
const warnReasons = () => warn.mock.calls.map((c) => String(c[0]));

describe('session title cloud write-back', () => {
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-title-push-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    const db = new DatabaseService(dataDir);
    await db.initialize();
    dbHolder.current = db;
    cloud.rows.clear();
    cloud.initialized = true;
    cloud.user = { id: 'user-1' };
    cloud.updateError = null;
    warn.mockReset();
    db.createSessionWithId(SID, {
      title: TRUNCATED, userId: 'user-1', modelConfig: { provider: 'zhipu', model: 'glm-4.7' }, createdAt: 1_000, updatedAt: 1_000,
    });
  });

  afterEach(async () => {
    dbHolder.current?.close();
    dbHolder.current = null;
    delete process.env.CODE_AGENT_DATA_DIR;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('pushes the smart title to the cloud row, and the after-run sync does not roll it back', async () => {
    await syncSupabaseSessionRow(sb, syncArgs); // 首轮前：插入截断档
    expect(cloudTitle()).toBe(TRUNCATED);

    const manager = await createManager();
    vi.spyOn(manager as unknown as { generateSmartTitle: () => Promise<unknown> }, 'generateSmartTitle')
      .mockResolvedValue({ title: SMART });
    await manager.addMessageToSession(SID, { id: 'm1', role: 'user', content: PROMPT, timestamp: 1_100 });
    await vi.waitFor(() => expect(cloudTitle()).toBe(SMART));

    await syncSupabaseSessionRow(sb, syncArgs); // 首轮后：同参数再调一次
    expect(cloudTitle()).toBe(SMART);
    expect(cloud.rows.get(SID)?.model_name).toBe('mimo');
  });

  it('without ignoreDuplicates semantics the first-turn row is still created once for a brand-new session', async () => {
    await syncSupabaseSessionRow(sb, syncArgs);
    expect(cloud.rows.get(SID)).toMatchObject({ user_id: 'user-1', title: TRUNCATED, source_device_id: 'web' });
  });

  it('pushes a manual rename and a second device pull takes it without flipping back', async () => {
    await syncSupabaseSessionRow(sb, syncArgs);
    const manager = await createManager();
    await manager.updateSession(SID, { title: '我手工起的名字' });
    await vi.waitFor(() => expect(cloudTitle()).toBe('我手工起的名字'));

    // 本机回声拉取：标题不变
    await manager.listSessions();
    await new Promise((r) => setTimeout(r, 50));
    expect(dbHolder.current!.getSession(SID)?.title).toBe('我手工起的名字');
    expect(cloudTitle()).toBe('我手工起的名字');

    // 第二台设备：全新数据目录，本地没有该会话，拉取后取云端标题
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'session-title-push2-'));
    const db2 = new DatabaseService(dir2);
    await db2.initialize();
    const first = dbHolder.current;
    dbHolder.current = db2;
    try {
      const manager2 = await createManager();
      await manager2.listSessions();
      await vi.waitFor(() => expect(db2.getSession(SID, { includeDeleted: true, userId: 'user-1' })?.title).toBe('我手工起的名字'));
    } finally {
      db2.close();
      dbHolder.current = first;
      await fs.rm(dir2, { recursive: true, force: true });
    }
  });

  it('second device takes the cloud smart title instead of the truncation', async () => {
    await syncSupabaseSessionRow(sb, syncArgs);
    const manager = await createManager();
    await manager.updateSession(SID, { title: SMART });
    await vi.waitFor(() => expect(cloudTitle()).toBe(SMART));
    await syncSupabaseSessionRow(sb, syncArgs);

    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'session-title-push2-'));
    const db2 = new DatabaseService(dir2);
    await db2.initialize();
    const first = dbHolder.current;
    dbHolder.current = db2;
    try {
      await (await createManager()).listSessions();
      await vi.waitFor(() => expect(db2.getSession(SID, { includeDeleted: true, userId: 'user-1' })?.title).toBe(SMART));
    } finally {
      db2.close();
      dbHolder.current = first;
      await fs.rm(dir2, { recursive: true, force: true });
    }
  });

  it('signed-out: no cloud call, local rename still lands, warn names the reason', async () => {
    await syncSupabaseSessionRow(sb, syncArgs);
    cloud.user = null;
    const db = dbHolder.current!;
    db.createSessionWithId('sess-anon', {
      title: '匿名会话', userId: null, modelConfig: { provider: 'zhipu', model: 'glm-4.7' }, createdAt: 1_000, updatedAt: 1_000,
    });
    const manager = await createManager();
    await expect(manager.updateSession('sess-anon', { title: '离线改名' })).resolves.toBeUndefined();
    await vi.waitFor(() => expect(warnReasons().some((m) => m.includes('no signed-in user'))).toBe(true));
    expect(cloudTitle()).toBe(TRUNCATED);
    expect(db.getSession('sess-anon')?.title).toBe('离线改名');
  });

  it('supabase not initialized / row absent / request error each warn a distinct reason and never throw', async () => {
    const manager = await createManager();

    cloud.initialized = false;
    await manager.updateSession(SID, { title: 'A 名' });
    await vi.waitFor(() => expect(warnReasons().some((m) => m.includes('not initialized'))).toBe(true));

    cloud.initialized = true;
    await manager.updateSession(SID, { title: 'B 名' }); // 云端无此行
    await vi.waitFor(() => expect(warnReasons().some((m) => m.includes('cloud row absent'))).toBe(true));
    expect(cloud.rows.size).toBe(0);

    await syncSupabaseSessionRow(sb, syncArgs);
    cloud.updateError = { message: 'boom' };
    await manager.updateSession(SID, { title: 'C 名' });
    await vi.waitFor(() => expect(warnReasons().some((m) => m.includes('request error'))).toBe(true));
    expect(dbHolder.current!.getSession(SID)?.title).toBe('C 名');
  });
});
