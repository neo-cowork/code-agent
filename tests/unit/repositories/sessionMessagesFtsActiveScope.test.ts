// 「全部」范围的跨会话搜索不再带已加载 id 限制：归档 / 已删除 / 他人会话必须在 SQL 层
// （LIMIT 之前）排除，否则它们的命中先占满候选，后置过滤后活跃会话的命中凭空消失。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import {
  runSessionMessagesFtsCount,
  runSessionMessagesFtsSearch,
} from '../../../src/host/services/core/repositories/sessionRepositoryFtsSearch';
import { searchSessionTitles } from '../../../src/host/services/core/repositories/sessionSearchMeta';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';

let db: BetterSqlite3.Database;

function seedSession(id: string, o: { status?: string; deleted?: number; user?: string | null } = {}): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, title, model_provider, model_name, status, is_deleted, created_at, updated_at)
     VALUES (?, ?, ?, 'test', 'test-model', ?, ?, 1, 1)`,
  ).run(id, o.user ?? null, `title-${id}`, o.status ?? 'idle', o.deleted ?? 0);
}

function seedMessage(sessionId: string, id: string, content: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, timestamp, is_meta, visibility)
     VALUES (?, ?, 'user', ?, ?, 0, 'active')`,
  ).run(id, sessionId, content, timestamp);
}

/** 3 个归档 + 3 个已删除 + 3 个他人会话，各有更新的命中；1 个活跃会话命中最老。 */
function seedCrowdedCorpus(word: string): void {
  seedSession('live');
  seedMessage('live', 'live-m', `live ${word} body ${'padding '.repeat(30)}`, 100);
  for (let i = 0; i < 3; i += 1) {
    seedSession(`arch-${i}`, { status: 'archived' });
    seedMessage(`arch-${i}`, `arch-m-${i}`, `archived ${word} body`, 1_000 + i);
    seedSession(`del-${i}`, { deleted: 1 });
    seedMessage(`del-${i}`, `del-m-${i}`, `deleted ${word} body`, 2_000 + i);
    seedSession(`other-${i}`, { user: 'someone-else' });
    seedMessage(`other-${i}`, `other-m-${i}`, `foreign ${word} body`, 3_000 + i);
  }
}

beforeEach(() => {
  db = new Database(':memory:');
  applyTestSessionSchema(db);
});
afterEach(() => db.close());

describe.each([
  ['FTS（≥3 字符）', 'zebra-quartz'],
  ['短查询 LIKE（2 字符）', '斑马'],
])('activeSessionScope — %s', (_label, word) => {
  it('with the scope, the active session survives the LIMIT and the others are excluded', () => {
    seedCrowdedCorpus(word);
    const hits = runSessionMessagesFtsSearch(db, word, {
      limit: 3,
      shortQueryFallback: true,
      activeSessionScope: { userId: null },
    });
    expect(hits.map((h) => h.sessionId)).toEqual(['live']);
  });

  it('counts only active sessions of the same owner', () => {
    seedCrowdedCorpus(word);
    seedSession('mine', { user: 'u1' });
    seedMessage('mine', 'mine-m', `mine ${word} body`, 50);
    expect(
      runSessionMessagesFtsCount(db, word, { shortQueryFallback: true, activeSessionScope: { userId: 'u1' } }),
    ).toEqual({ matches: 1, sessions: 1 });
    expect(
      runSessionMessagesFtsCount(db, word, { shortQueryFallback: true, activeSessionScope: { userId: null } }),
    ).toEqual({ matches: 1, sessions: 1 });
  });
});

describe.each([
  ['FTS（≥3 字符）', 'zebra-quartz'],
  ['短查询 LIKE（2 字符）', '斑马'],
])('activeSessionScope.includeArchived — %s', (_label, word) => {
  it('adds archived sessions to hits and counts, still excludes deleted and foreign sessions', () => {
    seedCrowdedCorpus(word);
    const ids = (includeArchived?: boolean) =>
      runSessionMessagesFtsSearch(db, word, {
        limit: 50,
        shortQueryFallback: true,
        activeSessionScope: { userId: null, includeArchived },
      })
        .map((h) => h.sessionId)
        .sort();
    expect(ids()).toEqual(['live']);
    expect(ids(true)).toEqual(['arch-0', 'arch-1', 'arch-2', 'live']);
    expect(
      runSessionMessagesFtsCount(db, word, { shortQueryFallback: true, activeSessionScope: { userId: null, includeArchived: true } }),
    ).toEqual({ matches: 4, sessions: 4 });
  });
});

describe('includeArchived + projectScope（真实 SQLite，标题 + FTS）', () => {
  const word = 'zebra-quartz';
  function seedProjectSession(id: string, projectId: string, status: string): void {
    seedSession(id, { status });
    db.prepare('UPDATE sessions SET project_id = ?, title = ? WHERE id = ?').run(projectId, `title ${word} ${id}`, id);
    seedMessage(id, `m-${id}`, `body ${word} ${id}`, 10);
  }
  beforeEach(() => {
    seedProjectSession('p1-live', 'proj-1', 'idle');
    seedProjectSession('p1-arch', 'proj-1', 'archived');
    seedProjectSession('p2-live', 'proj-2', 'idle');
    seedProjectSession('p2-arch', 'proj-2', 'archived');
  });

  it('FTS: project scope keeps only that project; includeArchived adds only that project\'s archived sessions', () => {
    const ids = (includeArchived: boolean) =>
      runSessionMessagesFtsSearch(db, word, {
        limit: 50,
        activeSessionScope: { userId: null, projectScope: { projectId: 'proj-1' }, includeArchived },
      })
        .map((h) => h.sessionId)
        .sort();
    expect(ids(false)).toEqual(['p1-live']);
    expect(ids(true)).toEqual(['p1-arch', 'p1-live']);
  });

  it('title: project scope + includeArchived', () => {
    const ids = (includeArchived: boolean) =>
      searchSessionTitles(db, word, null, 20, { projectId: 'proj-1' }, includeArchived).map((r) => r.sessionId).sort();
    expect(ids(false)).toEqual(['p1-live']);
    expect(ids(true)).toEqual(['p1-arch', 'p1-live']);
  });
});

describe('SessionRepository.unarchiveSession 时间戳', () => {
  it('带 updatedAt 时恢复到该时间（撤销回原位），不带则写当前时间', () => {
    seedSession('u1');
    const repo = new SessionRepository(db);
    repo.archiveSession('u1', 5_000);
    expect(repo.unarchiveSession('u1', 123)?.updatedAt).toBe(123);
    const before = Date.now();
    repo.archiveSession('u1');
    expect(repo.unarchiveSession('u1')?.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('SessionRepository.listArchivedSessions projectScope（真实 SQLite）', () => {
  function seedArchived(id: string, o: { projectId?: string; dir?: string; updated: number }): void {
    seedSession(id, { status: 'archived' });
    db.prepare('UPDATE sessions SET project_id = ?, working_directory = ?, updated_at = ? WHERE id = ?').run(
      o.projectId ?? null, o.dir ?? null, o.updated, id,
    );
  }
  beforeEach(() => {
    // 同一目录下：一个无项目、一个归属别的项目；另有 60 个更新的其他目录归档（会占满全局第一页）
    seedArchived('dir-plain', { dir: '/repo/x', updated: 1 });
    seedArchived('dir-owned-by-other', { projectId: 'proj-z', dir: '/repo/x', updated: 2 });
    seedArchived('proj-1-a', { projectId: 'proj-1', dir: '/repo/p1', updated: 3 });
    for (let i = 0; i < 60; i += 1) seedArchived(`noise-${i}`, { dir: '/repo/noise', updated: 1_000 + i });
  });

  it('projectId 范围：在分页之前过滤，最旧的本项目归档也在第一页', () => {
    const repo = new SessionRepository(db);
    expect(repo.listArchivedSessions(50, 0, null, { projectId: 'proj-1' }).map((s) => s.id)).toEqual(['proj-1-a']);
    // 对照：不带范围时全局第一页被噪音占满，看不到它
    expect(repo.listArchivedSessions(50, 0, null).map((s) => s.id)).not.toContain('proj-1-a');
  });

  it('workingDirectory 范围只命中没有 project_id 的会话（不含同目录下别的项目）', () => {
    const repo = new SessionRepository(db);
    expect(repo.listArchivedSessions(50, 0, null, { workingDirectory: '/repo/x' }).map((s) => s.id)).toEqual(['dir-plain']);
  });
});
