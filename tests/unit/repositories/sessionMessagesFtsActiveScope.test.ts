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
