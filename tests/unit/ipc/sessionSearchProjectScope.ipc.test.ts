// 「本项目」搜索范围由主机在 SQL 层按项目描述符过滤整库（不依赖渲染端已加载的会话 id）。
// 真 better-sqlite3 + 真 performCrossSessionSearch；只把 getDatabase 换成包着内存库的薄壳。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const holder = vi.hoisted(() => ({ database: undefined as unknown }));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => holder.database,
}));
vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));
vi.mock('../../../src/host/services/infra/logger', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: () => l, logger: l };
});

import { performCrossSessionSearch } from '../../../src/host/ipc/session.ipc';
import { getDefaultCache } from '../../../src/host/session/localCache';
import {
  runSessionMessagesFtsCount,
  runSessionMessagesFtsSearch,
} from '../../../src/host/services/core/repositories/sessionRepositoryFtsSearch';
import { getSessionSearchMeta, searchSessionTitles } from '../../../src/host/services/core/repositories/sessionSearchMeta';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';

let db: BetterSqlite3.Database;

function seed(id: string, o: { projectId?: string | null; cwd?: string | null; title?: string; at: number }, body?: string): void {
  db.prepare(
    `INSERT INTO sessions (id, title, model_provider, model_name, status, is_deleted, created_at, updated_at, project_id, working_directory)
     VALUES (?, ?, 'test', 'm', 'idle', 0, ?, ?, ?, ?)`,
  ).run(id, o.title ?? `title-${id}`, o.at, o.at, o.projectId ?? null, o.cwd ?? null);
  if (body) {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, timestamp, is_meta, visibility)
       VALUES (?, ?, 'user', ?, ?, 0, 'active')`,
    ).run(`${id}-m`, id, body, o.at);
  }
}

const ids = (r: { results: Array<{ sessionId: string }> }) => r.results.map((x) => x.sessionId).sort();

beforeEach(() => {
  getDefaultCache().clear();
  db = new Database(':memory:');
  applyTestSessionSchema(db);
  holder.database = {
    isReady: true,
    getMessages: () => [],
    searchSessionMessagesFts: (q: string, o: object) => runSessionMessagesFtsSearch(db, q, o),
    countSessionMessagesFts: (q: string, o: object) => runSessionMessagesFtsCount(db, q, o),
    getSessionSearchMeta: (i: string[], u: string | null, p?: never) => getSessionSearchMeta(db, i, u, p),
    searchSessionTitles: (q: string, u: string | null, l: number, p?: never) => searchSessionTitles(db, q, u, l, p),
  };
});
afterEach(() => db.close());

describe('performCrossSessionSearch projectScope', () => {
  const word = 'zebra-quartz';

  it('finds an old same-project session by a body-only word, excludes other projects, without sessionIds', async () => {
    seed('old-mine', { projectId: 'p1', at: 1 }, `meeting ${word} notes`);
    seed('other-proj', { projectId: 'p2', at: 2 }, `other ${word} notes`);
    seed('no-proj', { cwd: '/a', at: 3 }, `loose ${word} notes`);
    for (let i = 0; i < 65; i += 1) seed(`new-${i}`, { projectId: 'p1', at: 100 + i }, `filler ${i}`);

    const scoped = await performCrossSessionSearch(word, { limit: 80, projectScope: { projectId: 'p1' } });
    expect(ids(scoped)).toEqual(['old-mine']);
    const all = await performCrossSessionSearch(word, { limit: 80 });
    expect(ids(all)).toEqual(['no-proj', 'old-mine', 'other-proj']);
  });

  it('without a projectId, matches working_directory only for sessions that have no project', async () => {
    seed('same-dir', { cwd: '/a', at: 1 }, `x ${word}`);
    seed('dir-other-project', { projectId: 'p9', cwd: '/a', at: 2 }, `y ${word}`);
    seed('other-dir', { cwd: '/b', at: 3 }, `z ${word}`);
    const r = await performCrossSessionSearch(word, { projectScope: { projectId: '', workingDirectory: '/a' } });
    expect(ids(r)).toEqual(['same-dir']);
  });

  it('applies the project filter to title matches too', async () => {
    seed('t-mine', { projectId: 'p1', at: 1, title: 'budget review' });
    seed('t-other', { projectId: 'p2', at: 2, title: 'budget review' });
    const r = await performCrossSessionSearch('budget', { projectScope: { projectId: 'p1' } });
    expect(r.titleMatches?.map((m) => m.sessionId)).toEqual(['t-mine']);
  });
});
