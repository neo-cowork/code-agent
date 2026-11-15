// ============================================================================
// 云端标题回灌守卫（FB-1089 / N-FIX-SESSION-TITLE-REVERTS-TO-RAW-MESSAGE）
// 第二轮结束后侧栏智能标题被顶回「首条消息前 30 字 + ...」：云端 sessions 行只有
// web 首轮写入的截断档且每轮只顶 updated_at（syncSupabaseSessionRow 只在 isNewSession
// 写 title），SessionManager.syncSessionListFromCloud（经 listSessions 触发）在云端
// 时间戳更新时把该截断档整行写回本地。这里用真 sqlite + 真 SessionManager + 假
// Supabase 客户端复现该分支，并钉住修复：本地已定档标题（智能标题/用户命名）不被
// 截断档顶回，云端真改名照旧取胜，其余云端元数据（updatedAt/model）照常落地。
// ============================================================================

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Message } from '../../../../src/shared/contract';

const dbHolder = vi.hoisted(() => ({ current: null as DatabaseService | null }));
const sendMock = vi.hoisted(() => vi.fn());
const cloud = vi.hoisted(() => ({ sessions: [] as Array<Record<string, unknown>> }));
const ensureProjectForWorkspaceMock = vi.hoisted(() => vi.fn());

vi.unmock('better-sqlite3');

vi.mock('../../../../src/host/services/core/database/nativeLoader', async () => {
  const module = await import('better-sqlite3');
  return {
    loadBetterSqlite3: () => module.default,
  };
});

// SessionManager 从 core barrel 取 getDatabase；barrel 只替换 getDatabase 指向本测试的
// 真 DatabaseService（与 tests/unit/memory/memoryJournalActor.test.ts 同款做法）
vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => {
    if (!dbHolder.current) throw new Error('Database not initialized');
    return dbHolder.current;
  },
}));

vi.mock('../../../../src/host/platform', () => ({
  AppWindow: {
    getAllWindows: () => [{ webContents: { send: sendMock } }],
  },
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({
    getCurrentUser: () => ({ id: 'user-1' }),
  }),
}));

vi.mock('../../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({ clearSession: vi.fn() }),
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => true,
  getSupabase: () => ({
    from: (table: string) => {
      if (table !== 'sessions') throw new Error(`unexpected supabase table: ${table}`);
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => Promise.resolve({ data: cloud.sessions, error: null }),
      };
      return builder;
    },
  }),
}));

vi.mock('../../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({
    ensureProjectForWorkspace: ensureProjectForWorkspaceMock,
  }),
}));

import { DatabaseService } from '../../../../src/host/services/core/databaseService';
import { shouldKeepLocalTitleOverCloud } from '../../../../src/shared/sessionTitlePlaceholder';

const PROMPT = '我是第一次使用 Neo。请帮我写一份自我介绍并生成可打开查看的档案';
const TRUNCATED = `${PROMPT.slice(0, 30)}...`;
const SMART_TITLE = '小星的自我介绍与第一份档案生成';

let dataDir = '';
let messageCounter = 0;

function userMessage(content: string, timestamp: number): Message {
  return { id: `msg-${++messageCounter}`, role: 'user', content, timestamp };
}

function assistantMessage(content: string, timestamp: number): Message {
  return { id: `msg-${++messageCounter}`, role: 'assistant', content, timestamp };
}

async function createManager(): Promise<import('../../../../src/host/services/infra/sessionManager').SessionManager> {
  const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
  return new SessionManager();
}

describe('SessionManager cloud title write-back guard (FB-1089)', () => {
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-title-revert-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    const db = new DatabaseService(dataDir);
    await db.initialize();
    dbHolder.current = db;
    cloud.sessions = [];
    ensureProjectForWorkspaceMock.mockReset();
    ensureProjectForWorkspaceMock.mockResolvedValue({ id: 'project-cloud' });
    sendMock.mockReset();
  });

  afterEach(async () => {
    dbHolder.current?.close();
    dbHolder.current = null;
    delete process.env.CODE_AGENT_DATA_DIR;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('keeps the local smart title when a newer cloud row still carries the turn-1 truncation', async () => {
    const db = dbHolder.current!;
    const sessionId = 'sess-fb1089';
    db.createSessionWithId(sessionId, {
      title: SMART_TITLE,
      userId: 'user-1',
      modelConfig: { provider: 'zhipu', model: 'glm-4.7' },
      workingDirectory: '/repo/dogfood',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    db.addMessage(sessionId, userMessage(PROMPT, 1_100));
    db.addMessage(sessionId, assistantMessage('好的，这是你的自我介绍。', 1_200));
    db.addMessage(sessionId, userMessage('把它恢复成完整版', 2_100));

    const localUpdatedAt = db.getSession(sessionId)!.updatedAt;
    cloud.sessions = [{
      id: sessionId,
      title: TRUNCATED,
      model_provider: 'moonshot',
      model_name: 'mimo-v2.6-flash',
      working_directory: '/repo/dogfood',
      created_at: 1_000,
      updated_at: localUpdatedAt + 5_000,
      is_deleted: false,
    }];

    const manager = await createManager();
    await manager.listSessions();

    await vi.waitFor(() => {
      expect(db.getSession(sessionId)?.modelConfig.model).toBe('mimo-v2.6-flash');
    });

    const stored = db.getSession(sessionId)!;
    expect(stored.title).toBe(SMART_TITLE);
    expect(stored.title).not.toBe(TRUNCATED);
    expect(stored.updatedAt).toBe(localUpdatedAt + 5_000);
    expect(stored.modelConfig.provider).toBe('moonshot');
  });

  it('keeps a local manual rename over a newer provisional cloud title', async () => {
    const db = dbHolder.current!;
    const sessionId = 'sess-rename';
    db.createSessionWithId(sessionId, {
      title: '用户手工命名',
      userId: 'user-1',
      modelConfig: { provider: 'zhipu', model: 'glm-4.7' },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    db.addMessage(sessionId, userMessage(PROMPT, 1_100));
    const localUpdatedAt = db.getSession(sessionId)!.updatedAt;

    cloud.sessions = [{
      id: sessionId,
      title: TRUNCATED,
      model_provider: 'zhipu',
      model_name: 'glm-4.7',
      working_directory: undefined,
      created_at: 1_000,
      updated_at: localUpdatedAt + 5_000,
      is_deleted: false,
    }];

    const manager = await createManager();
    await manager.listSessions();

    await vi.waitFor(() => {
      expect(db.getSession(sessionId)?.updatedAt).toBe(localUpdatedAt + 5_000);
    });

    expect(db.getSession(sessionId)!.title).toBe('用户手工命名');
  });

  it('keeps a local manual rename when the cloud title is the verbatim short prompt (no ellipsis)', async () => {
    const db = dbHolder.current!;
    const sessionId = 'sess-short-prompt';
    const shortPrompt = '帮我写个快速排序';
    db.createSessionWithId(sessionId, {
      title: '用户手工命名',
      userId: 'user-1',
      modelConfig: { provider: 'zhipu', model: 'glm-4.7' },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    db.addMessage(sessionId, userMessage(shortPrompt, 1_100));
    const localUpdatedAt = db.getSession(sessionId)!.updatedAt;

    // buildSessionTitle 对 ≤30 字 prompt 不加 "..."，原样入列——同一自动产物
    cloud.sessions = [{
      id: sessionId,
      title: shortPrompt,
      model_provider: 'zhipu',
      model_name: 'glm-4.7',
      created_at: 1_000,
      updated_at: localUpdatedAt + 5_000,
      is_deleted: false,
    }];

    const manager = await createManager();
    await manager.listSessions();

    await vi.waitFor(() => {
      expect(db.getSession(sessionId)?.updatedAt).toBe(localUpdatedAt + 5_000);
    });

    expect(db.getSession(sessionId)!.title).toBe('用户手工命名');
  });

  it('still applies a genuine cloud rename (non-provisional) to the local row', async () => {
    const db = dbHolder.current!;
    const sessionId = 'sess-cloud-rename';
    db.createSessionWithId(sessionId, {
      title: '用户手工命名',
      userId: 'user-1',
      modelConfig: { provider: 'zhipu', model: 'glm-4.7' },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    db.addMessage(sessionId, userMessage(PROMPT, 1_100));
    const localUpdatedAt = db.getSession(sessionId)!.updatedAt;

    cloud.sessions = [{
      id: sessionId,
      title: '手机上改的新名字',
      model_provider: 'zhipu',
      model_name: 'glm-4.7',
      created_at: 1_000,
      updated_at: localUpdatedAt + 5_000,
      is_deleted: false,
    }];

    const manager = await createManager();
    await manager.listSessions();

    await vi.waitFor(() => {
      expect(db.getSession(sessionId)?.title).toBe('手机上改的新名字');
    });

    expect(db.getSession(sessionId)!.updatedAt).toBe(localUpdatedAt + 5_000);
  });

  it('createSessionWithId remote upsert does not clobber a real title on a message-bearing owner-mismatched row', async () => {
    const db = dbHolder.current!;
    const sessionId = 'sess-owner-claim';
    // 本地行 user_id 为 NULL：owner 过滤的 getSession 查不到 → 走 createSessionWithId
    // 的幂等 upsert（ON CONFLICT ... title = excluded.title）。行上有消息 → 不可变对话
    // 边界账本（conversation_branches）已立，owner 与云端不一致时整个 upsert 被
    // assertRemoteSessionBoundaryCompatible 拦下，标题因此幸存——本用例钉住这个
    // 可达性事实：该 sink 的标题覆写在「有消息的行」上结构性不可达。
    db.createSessionWithId(sessionId, {
      title: SMART_TITLE,
      userId: null,
      modelConfig: { provider: 'zhipu', model: 'glm-4.7' },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    db.addMessage(sessionId, userMessage(PROMPT, 1_100), { skipTimestampUpdate: true });

    cloud.sessions = [{
      id: sessionId,
      title: TRUNCATED,
      model_provider: 'moonshot',
      model_name: 'mimo-v2.6-flash',
      working_directory: '/repo/dogfood',
      created_at: 1_000,
      updated_at: 6_000,
      is_deleted: false,
    }];

    const manager = await createManager();
    await manager.listSessions();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const stored = db.getSession(sessionId, { includeDeleted: true })!;
    expect(stored.title).toBe(SMART_TITLE);
    expect(stored.title).not.toBe(TRUNCATED);
    expect(stored.userId).toBeNull();
  });

  it('a cloud-only session still lands locally with its cloud title', async () => {
    const db = dbHolder.current!;
    const sessionId = 'sess-cloud-only';
    cloud.sessions = [{
      id: sessionId,
      title: '云端起的会话名',
      model_provider: 'moonshot',
      model_name: 'mimo-v2.6-flash',
      working_directory: '/repo/cloud',
      created_at: 1_000,
      updated_at: 2_000,
      is_deleted: false,
    }];

    const manager = await createManager();
    await manager.listSessions();

    await vi.waitFor(() => {
      expect(db.getSession(sessionId, { includeDeleted: true, userId: 'user-1' })).not.toBeNull();
    });

    expect(db.getSession(sessionId, { includeDeleted: true, userId: 'user-1' })!.title).toBe('云端起的会话名');
  });
});

describe('shouldKeepLocalTitleOverCloud (pure predicate)', () => {
  it('keeps a real local title against truncation / placeholder / verbatim-short-prompt cloud titles', () => {
    expect(shouldKeepLocalTitleOverCloud(SMART_TITLE, TRUNCATED, PROMPT)).toBe(true);
    expect(shouldKeepLocalTitleOverCloud('用户手工命名', '新对话', PROMPT)).toBe(true);
    expect(shouldKeepLocalTitleOverCloud('用户手工命名', null, PROMPT)).toBe(true);
    expect(shouldKeepLocalTitleOverCloud('用户手工命名', '帮我写个快速排序', '帮我写个快速排序')).toBe(true);
  });

  it('lets a genuine cloud rename through and does not keep a provisional local title', () => {
    expect(shouldKeepLocalTitleOverCloud('用户手工命名', '手机上改的新名字', PROMPT)).toBe(false);
    expect(shouldKeepLocalTitleOverCloud(TRUNCATED, TRUNCATED, PROMPT)).toBe(false);
    expect(shouldKeepLocalTitleOverCloud('新对话', TRUNCATED, PROMPT)).toBe(false);
    // 无源文本（消息未拉到本地）时判不了自动档，云端照旧取胜
    expect(shouldKeepLocalTitleOverCloud(SMART_TITLE, TRUNCATED, '')).toBe(false);
  });
});
