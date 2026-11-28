// 只出现在 role:'tool' 行（工具输出）里的词，在「当前项目」与「全部」两个范围都要能搜到，
// 摘要取自 output 文字（不带 JSON 外壳）。真 better-sqlite3 + 真 performCrossSessionSearch。
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
import type { TraceProjection } from '../../../src/shared/contract/trace';
import { getDefaultCache, SessionLocalCache } from '../../../src/host/session/localCache';
import {
  createPendingSearchJumpFromCrossSessionResult,
  findSearchMatchForPendingJump,
} from '../../../src/renderer/utils/sessionSearchJump';
import { searchSessions, type SessionSearchFtsSource } from '../../../src/host/session/search';
import {
  runSessionMessagesFtsCount,
  runSessionMessagesFtsSearch,
} from '../../../src/host/services/core/repositories/sessionRepositoryFtsSearch';
import { getSessionSearchMeta, searchSessionTitles } from '../../../src/host/services/core/repositories/sessionSearchMeta';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';

let db: BetterSqlite3.Database;
const TOKEN = 'ZK-4471-QUARTZ';

function seedSession(id: string, projectId: string, at: number): void {
  db.prepare(
    `INSERT INTO sessions (id, title, model_provider, model_name, status, is_deleted, created_at, updated_at, project_id)
     VALUES (?, ?, 'test', 'm', 'idle', 0, ?, ?, ?)`,
  ).run(id, `title-${id}`, at, at, projectId);
}

function seedMessage(id: string, sessionId: string, role: string, content: string, at: number): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, timestamp, is_meta, visibility)
     VALUES (?, ?, ?, ?, ?, 0, 'active')`,
  ).run(id, sessionId, role, content, at);
}

const toolContent = JSON.stringify([
  { toolCallId: 'call-1', success: true, output: `vendor notes\ndeadline is Friday, code ${TOKEN}` },
]);

beforeEach(() => {
  getDefaultCache().clear();
  db = new Database(':memory:');
  applyTestSessionSchema(db);
  seedSession('s1', 'p1', 1000);
  seedMessage('s1-u', 's1', 'user', 'read vendor_notes.txt for me', 1000);
  seedMessage('s1-t', 's1', 'tool', toolContent, 1001);
  seedMessage('s1-a', 's1', 'assistant', 'The deadline is Friday.', 1002);
  holder.database = {
    isReady: true,
    // 与真实 getMessages 之后的 isCacheable 过滤同形：缓存回填只有 user/assistant/system
    getMessages: (sid: string) =>
      (db.prepare('SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp').all(sid) as Array<{ id: string; role: string; content: string; timestamp: number }>),
    searchSessionMessagesFts: (q: string, o: object) => runSessionMessagesFtsSearch(db, q, o),
    countSessionMessagesFts: (q: string, o: object) => runSessionMessagesFtsCount(db, q, o),
    getSessionSearchMeta: (i: string[], u: string | null, p?: never) => getSessionSearchMeta(db, i, u, p),
    searchSessionTitles: (q: string, u: string | null, l: number, p?: never) => searchSessionTitles(db, q, u, l, p),
  };
});
afterEach(() => db.close());

describe('tool-output hits in cross-session search', () => {
  it('returns the session for a tool-only word with projectScope current-project', async () => {
    const r = await performCrossSessionSearch(TOKEN, { projectScope: { projectId: 'p1' } });
    expect(r.results.map((x) => x.sessionId)).toEqual(['s1']);
    expect(r.results[0].role).toBe('tool');
    expect(r.results[0].messageId).toBe('s1-t');
  });

  it('returns the session for a tool-only word with scope all', async () => {
    const r = await performCrossSessionSearch(TOKEN, {});
    expect(r.results.map((x) => x.sessionId)).toEqual(['s1']);
  });

  it('builds the snippet from the tool output text, without the JSON wrapper', async () => {
    const r = await performCrossSessionSearch(TOKEN, {});
    const snippet = r.results[0].snippet;
    expect(snippet).toContain(TOKEN);
    expect(snippet).not.toContain('{"');
    expect(snippet).not.toContain('toolCallId');
  });

  it('strips the Read tool header and line-number gutter from the snippet', async () => {
    seedMessage('s1-read', 's1', 'tool', JSON.stringify([
      { toolCallId: 'call-2', success: true, output: 'Read version digest: adc64d59c70fe897\n     1\tVendor notes (Q3)\n     2\tSupplier code: READ-ONLY-TOKEN-77\n     3\tDeadline 14 November\n     4\t\n\n<document-evidence>{"path":"/tmp/ws/vendor_notes.txt","digest":"abc"}; local file content, source independence unverified</document-evidence>' },
    ]), 1003);
    const r = await performCrossSessionSearch('READ-ONLY-TOKEN-77', {});
    const snippet = r.results[0].snippet;
    expect(snippet).toContain('READ-ONLY-TOKEN-77');
    expect(snippet).not.toContain('version digest');
    expect(snippet).not.toContain('document-evidence');
    expect(snippet).not.toMatch(/\d+\t/);
    expect(snippet).not.toMatch(/(^|\s)\d+ Vendor/);
    expect(snippet.trimEnd()).toMatch(/14 November$/);
  });

  it('does not return tool rows when the caller filters role=user', async () => {
    const r = await performCrossSessionSearch(TOKEN, { role: 'user' });
    expect(r.results).toEqual([]);
  });
});

describe('in-memory path agrees with FTS path', () => {
  // 内存缓存的类型与两处回填（isCacheableMessage / isCacheableSearchMessage）都只收
  // user/assistant/system，结构上不会有 tool 行；内存路径只在 DB 未就绪或
  // caseSensitive/useRegex 时用。这里钉住 role 过滤两条路径一致。
  const memoryCache = (): SessionLocalCache => {
    const cache = new SessionLocalCache();
    cache.setSession({
      sessionId: 's1',
      messages: [{ id: 's1-u', role: 'user', content: `read it ${TOKEN}`, timestamp: 1000 }],
      startedAt: 1000,
      lastActivityAt: 1000,
      totalTokens: 0,
    });
    return cache;
  };
  const ftsSource = (): SessionSearchFtsSource => ({
    isReady: true,
    searchSessionMessagesFts: (q, o) => runSessionMessagesFtsSearch(db, q, o ?? {}),
    countSessionMessagesFts: (q, o) => runSessionMessagesFtsCount(db, q, o ?? {}),
    getMessages: () => [],
  });

  it('FTS path returns the tool hit with an output-only snippet', () => {
    const fts = searchSessions(TOKEN, {}, new SessionLocalCache(), ftsSource());
    expect(fts.results.map((x) => x.message.role)).toEqual(['tool']);
    expect(fts.results[0].snippet).toContain(TOKEN);
    expect(fts.results[0].snippet).not.toContain('toolCallId');
  });

  it('both paths return no tool row for role=user (FTS has the tool-only word, memory has no tool rows)', () => {
    seedSession('s2', 'p1', 2000);
    seedMessage('s2-t', 's2', 'tool', JSON.stringify([{ toolCallId: 'c', success: true, output: 'only-in-tool-xyz' }]), 2001);
    const memCache = memoryCache();
    expect(searchSessions('only-in-tool-xyz', { role: 'user' }, memCache).results).toEqual([]);
    expect(searchSessions('only-in-tool-xyz', { role: 'user' }, new SessionLocalCache(), ftsSource()).results).toEqual([]);
    expect(searchSessions(TOKEN, { role: 'user' }, new SessionLocalCache(), ftsSource()).results).toEqual([]);
  });
});

describe('tie-break', () => {
  it('orders assistant before tool at equal relevance', () => {
    const text = `shared ${TOKEN} text`;
    const source: SessionSearchFtsSource = {
      isReady: true,
      searchSessionMessagesFts: () => [
        { messageId: 'm-tool', sessionId: 'sa', role: 'tool', content: JSON.stringify([{ toolCallId: 'c', success: true, output: text }]), timestamp: 5 },
        { messageId: 'm-asst', sessionId: 'sb', role: 'assistant', content: text, timestamp: 5 },
      ],
      countSessionMessagesFts: () => ({ matches: 2, sessions: 2 }),
      getMessages: () => [],
    };
    const r = searchSessions(TOKEN, {}, new SessionLocalCache(), source);
    expect(r.results[0].relevance).toBe(r.results[1].relevance);
    expect(r.results.map((x) => x.message.role)).toEqual(['assistant', 'tool']);
  });
});

// caseSensitive / useRegex 回落内存分支：缓存回填只收 user/assistant/system，
// 但 DB 就绪时从同一回填窗口补读 role:'tool' 行，命中与默认 FTS 调用一致
//（sessionId / messageId / role / turnNumber / messageIndex）。IPC 只转发
// caseSensitive（无 useRegex 字段），useRegex 用例走公开的 searchSessions 入口。
describe('caseSensitive / useRegex memory fallback also finds tool-only words', () => {
  // 与 IPC 注入的同一形状数据源（真 better-sqlite3；getMessages 返回含 tool 行的原始行）
  const dbSource = (): SessionSearchFtsSource => holder.database as unknown as SessionSearchFtsSource;
  // 默认 FTS 调用触发真实回填（getOrHydrateSearchSession 只收 user/assistant/system）
  const hydratedCache = (): SessionLocalCache => {
    const cache = new SessionLocalCache();
    searchSessions(TOKEN, {}, cache, dbSource());
    return cache;
  };

  it('caseSensitive:true finds the tool-only word with the same hit as the default FTS call (IPC entry)', async () => {
    const fts = await performCrossSessionSearch(TOKEN, {});
    expect(fts.results).toHaveLength(1);
    const ftsHit = fts.results[0];
    expect(ftsHit).toMatchObject({ sessionId: 's1', messageId: 's1-t', role: 'tool', messageIndex: -1 });
    expect(ftsHit.turnNumber).toBeUndefined();

    const memory = await performCrossSessionSearch(TOKEN, { sessionIds: ['s1'], caseSensitive: true });
    expect(memory.results).toHaveLength(1);
    expect(memory.results[0]).toMatchObject({
      sessionId: ftsHit.sessionId,
      messageId: ftsHit.messageId,
      role: 'tool',
      messageIndex: ftsHit.messageIndex,
      matchOffset: ftsHit.matchOffset,
    });
    expect(memory.results[0].turnNumber).toBe(ftsHit.turnNumber);
    expect(memory.results[0].snippet).toContain(TOKEN);
    expect(memory.results[0].snippet).not.toContain('{"');
  });

  it('useRegex:true finds the tool-only word with the same hit as the default FTS call (searchSessions entry)', () => {
    const fts = searchSessions(TOKEN, {}, new SessionLocalCache(), dbSource());
    expect(fts.results).toHaveLength(1);
    const ftsHit = fts.results[0];

    const memory = searchSessions(TOKEN, { useRegex: true }, hydratedCache(), dbSource());
    expect(memory.results).toHaveLength(1);
    expect(memory.results[0].sessionId).toBe(ftsHit.sessionId);
    expect(memory.results[0].message.id).toBe(ftsHit.message.id);
    expect(memory.results[0].message.role).toBe('tool');
    expect(memory.results[0].messageIndex).toBe(ftsHit.messageIndex);
    expect(memory.results[0].turnNumber).toBe(ftsHit.turnNumber);
    expect(memory.results[0].message.content).toBe(ftsHit.message.content);
  });

  it('useRegex pattern semantics are evaluated on the extracted tool output text', () => {
    const memory = searchSessions('ZK-\\d{4}-QUARTZ', { useRegex: true }, hydratedCache(), dbSource());
    expect(memory.results.map((x) => x.message.id)).toEqual(['s1-t']);
    expect(memory.results[0].message.role).toBe('tool');
    expect(memory.results[0].messageIndex).toBe(-1);
    expect(memory.results[0].turnNumber).toBeUndefined();
    expect(memory.results[0].snippet).toContain(TOKEN);
  });

  it('caseSensitive:true does not hit when the case does not match', async () => {
    const memory = await performCrossSessionSearch(TOKEN.toLowerCase(), { sessionIds: ['s1'], caseSensitive: true });
    expect(memory.results).toEqual([]);
    expect(memory.totalMatches).toBe(0);
  });

  it('useRegex:true does not hit when the pattern does not match', () => {
    const memory = searchSessions('ZK-\\d{5}-QUARTZ', { useRegex: true }, hydratedCache(), dbSource());
    expect(memory.results).toEqual([]);
    expect(memory.totalMatches).toBe(0);
  });

  // FB-1998 复查钉：JSON 外壳字段名（content / role / toolCallId / "output" / {"）
  // 在内存分支不得造成假命中——tool 行参与匹配的是 extractToolOutputText 剥壳后的
  // 输出文字，不是原始 JSON 串；摘要同样不含 {"。
  it('JSON-shell field names do not falsely hit on the memory branch', async () => {
    for (const needle of ['content', 'role', 'toolCallId', '"output"', '\\{"']) {
      const cs = await performCrossSessionSearch(needle, { sessionIds: ['s1'], caseSensitive: true });
      expect(cs.results, `caseSensitive ${needle}`).toEqual([]);
      const rx = searchSessions(needle, { useRegex: true }, hydratedCache(), dbSource());
      expect(rx.results, `useRegex ${needle}`).toEqual([]);
    }
  });
});

// 旧组队配方行：用户消息以「【组队 · 配方名】」开头（气泡已剥掉前缀，legacyTeamRecipeDisplay.ts）。
// IPC 结果的 snippet / matchOffset 由 session.ipc.ts 从搜索结果映射而来，必须同样只含用户原话。
describe('legacy team-recipe prefix on user rows', () => {
  const STRIPPED = '会员增长方案';
  const RAW = `【组队 · 产品规格】${STRIPPED}`;

  async function legacyHit(query: string) {
    const item = (await performCrossSessionSearch(query, {})).results.find((x) => x.messageId === 's1-legacy');
    if (!item) throw new Error(`s1-legacy not returned for query ${query}`);
    return item;
  }

  beforeEach(() => {
    seedMessage('s1-legacy', 's1', 'user', RAW, 1003);
  });

  it('maps a clean snippet and a stripped-text offset into the IPC result', async () => {
    for (const query of ['增长方案', '增长']) {
      expect(await legacyHit(query), query).toMatchObject({
        sessionId: 's1',
        role: 'user',
        snippet: STRIPPED.replace(query, `**${query}**`),
        matchOffset: STRIPPED.indexOf(query),
        matchCount: 1,
      });
    }
  });

  it('does not return the legacy row when the query only appears in its prefix', async () => {
    for (const query of ['组队', '产品规格']) {
      const r = await performCrossSessionSearch(query, {});
      expect(r.results.map((x) => x.messageId), query).toEqual([]);
      expect(r.totalMatches, query).toBe(0);
    }
  });

  it('host matchOffset and the renderer jump offset both index the stripped text', async () => {
    for (const query of ['会员', '增长']) {
      const item = await legacyHit(query);
      const jump = createPendingSearchJumpFromCrossSessionResult(item, query);
      const projection: TraceProjection = {
        sessionId: 's1',
        activeTurnIndex: -1,
        turns: [{
          turnNumber: 1,
          turnId: 'turn-1',
          status: 'completed',
          startTime: 1000,
          nodes: [
            { id: 's1-u', type: 'user', content: 'read vendor_notes.txt for me', timestamp: 1000 },
            { id: 's1-legacy', type: 'user', content: RAW, timestamp: 1003 },
          ],
        }],
      };
      const match = findSearchMatchForPendingJump(projection, jump);

      expect(item.matchOffset, query).toBe(STRIPPED.indexOf(query));
      expect(jump.matchOffset, query).toBe(STRIPPED.indexOf(query));
      expect(match?.offset, query).toBe(STRIPPED.indexOf(query));
    }
  });
});
