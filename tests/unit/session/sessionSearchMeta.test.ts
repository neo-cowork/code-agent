import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import {
  getSessionSearchMeta,
  searchSessionTitles,
} from '../../../src/host/services/core/repositories/sessionSearchMeta';

let db: Database.Database;

function seed(id: string, title: string, o: { status?: string; deleted?: number; user?: string | null; updated?: number } = {}): void {
  db.prepare(
    'INSERT INTO sessions (id, title, status, is_deleted, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, title, o.status ?? 'idle', o.deleted ?? 0, o.user ?? null, 1, o.updated ?? 1);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, title TEXT, status TEXT, is_deleted INTEGER DEFAULT 0,
    user_id TEXT, created_at INTEGER, updated_at INTEGER)`);
});
afterEach(() => db.close());

describe('searchSessionTitles', () => {
  it('matches case-insensitively, skips archived/deleted, newest first, honours limit', () => {
    seed('a', 'Alpha Needle', { updated: 10 });
    seed('b', 'beta NEEDLE two', { updated: 30 });
    seed('c', 'needle archived', { status: 'archived', updated: 50 });
    seed('d', 'needle deleted', { deleted: 1, updated: 60 });
    seed('e', 'unrelated');
    expect(searchSessionTitles(db, 'needle', null, 20).map((r) => r.sessionId)).toEqual(['b', 'a']);
    expect(searchSessionTitles(db, 'needle', null, 1).map((r) => r.sessionId)).toEqual(['b']);
  });

  it('treats % and _ literally and filters by owner', () => {
    seed('p', '100% done', { user: 'u1' });
    seed('q', '1000 done', { user: 'u1' });
    seed('r', 'a_b', { user: 'u2' });
    expect(searchSessionTitles(db, '100%', 'u1', 20).map((r) => r.sessionId)).toEqual(['p']);
    expect(searchSessionTitles(db, 'a_b', 'u1', 20)).toEqual([]);
    expect(searchSessionTitles(db, 'a_b', 'u2', 20).map((r) => r.sessionId)).toEqual(['r']);
  });

  it('finds a Chinese word shorter than the trigram FTS minimum', () => {
    seed('z', '浏览器采集任务');
    expect(searchSessionTitles(db, '采集', null, 20).map((r) => r.sessionId)).toEqual(['z']);
  });
});

describe('getSessionSearchMeta', () => {
  it('returns title/updatedAt/archived, hides deleted and other owners', () => {
    seed('x', 'Mine', { updated: 7, status: 'archived', user: 'u1' });
    seed('y', 'Theirs', { user: 'u2' });
    seed('w', 'Gone', { deleted: 1, user: 'u1' });
    expect(getSessionSearchMeta(db, ['x', 'y', 'w', 'missing'], 'u1')).toEqual([
      { sessionId: 'x', title: 'Mine', updatedAt: 7, createdAt: 1, archived: true },
    ]);
    expect(getSessionSearchMeta(db, [], 'u1')).toEqual([]);
  });
});


it('finds localized schedule and heartbeat titles before LIMIT without crossing owner fences', () => {
  seed('old', '[Cron] 周报', { user: 'u1', updated: 10 });
  seed('beat', '[HEARTBEAT] 巡检', { user: 'u1', updated: 20 });
  seed('renamed', '[定时] 月报', { user: 'u1', updated: 30 });
  seed('private', '[Schedule] 周报', { user: 'u2', updated: 90 });
  seed('archived', '[Schedule] 周报', { user: 'u1', status: 'archived', updated: 99 });
  seed('unrelated', '周报', { user: 'u1', updated: 100 });
  expect(searchSessionTitles(db, '定时', 'u1', 1).map((r) => r.sessionId)).toEqual(['renamed']);
  expect(searchSessionTitles(db, 'Schedule', 'u1', 10).map((r) => r.sessionId)).toEqual(['renamed', 'old']);
  expect(searchSessionTitles(db, '心跳', 'u1', 10).map((r) => r.sessionId)).toEqual(['beat']);
  expect(searchSessionTitles(db, '[Cron]', 'u1', 10).map((r) => r.sessionId)).toEqual(['old']);
  expect(searchSessionTitles(db, '[定时] 周报', 'u1', 10).map((r) => r.sessionId)).toEqual(['old']);
});
