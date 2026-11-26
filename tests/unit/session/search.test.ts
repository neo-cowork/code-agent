import { describe, expect, it } from 'vitest';
import {
  inferConversationTurnNumbers,
  searchSessions,
} from '../../../src/host/session/search';
import { SessionLocalCache } from '../../../src/host/session/localCache';

describe('session search', () => {
  it('infers conversation turn numbers from cached message order', () => {
    expect(inferConversationTurnNumbers([
      { id: 'system-1', role: 'system', content: 'Boot', timestamp: 1 },
      { id: 'user-1', role: 'user', content: 'First task', timestamp: 2 },
      { id: 'assistant-1', role: 'assistant', content: 'First answer', timestamp: 3 },
      { id: 'system-2', role: 'system', content: 'Notice', timestamp: 4 },
      { id: 'user-2', role: 'user', content: 'Second task', timestamp: 5 },
      { id: 'assistant-2', role: 'assistant', content: 'Second answer', timestamp: 6 },
    ])).toEqual([
      undefined,
      1,
      1,
      1,
      2,
      2,
    ]);
  });

  it('includes inferred turn numbers in search results', () => {
    const cache = new SessionLocalCache();
    cache.setSession({
      sessionId: 'session-1',
      startedAt: 1,
      lastActivityAt: 6,
      totalTokens: 0,
      messages: [
        { id: 'user-1', role: 'user', content: 'First task', timestamp: 1 },
        { id: 'assistant-1', role: 'assistant', content: 'No match here', timestamp: 2 },
        { id: 'user-2', role: 'user', content: 'Second task', timestamp: 3 },
        { id: 'assistant-2', role: 'assistant', content: 'Needle appears here', timestamp: 4 },
      ],
    });

    const result = searchSessions('Needle', { sessionIds: ['session-1'] }, cache);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      sessionId: 'session-1',
      messageIndex: 3,
      turnNumber: 2,
    });
  });

  it('keeps runtime supplements inside the current renderer turn', () => {
    const messages = [
      { id: 'user-1', role: 'user' as const, content: 'First task', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant' as const, content: 'First answer', timestamp: 2 },
      {
        id: 'user-supplement-1',
        role: 'user' as const,
        content: 'Needle supplement',
        timestamp: 3,
        metadata: {
          workbench: {
            runtimeInputMode: 'supplement',
          },
        },
      },
      { id: 'assistant-2', role: 'assistant' as const, content: 'Supplement handled', timestamp: 4 },
      {
        id: 'user-queued-1',
        role: 'user' as const,
        content: 'Queued next task',
        timestamp: 5,
        metadata: {
          workbench: {
            runtimeInputMode: 'supplement',
          },
        },
      },
    ];

    expect(inferConversationTurnNumbers(messages)).toEqual([1, 1, 1, 1, 1]);
  });
});

// 旧组队配方行：用户消息以「【组队 · 配方名】」开头（气泡已剥掉前缀，legacyTeamRecipeDisplay.ts），
// 搜索同口径——匹配 / 偏移 / 摘要只看剥掉前缀后的用户原话
describe('session search — legacy team-recipe prefix on user messages', () => {
  const STRIPPED = '会员增长方案';
  const RAW = `【组队 · 产品规格】${STRIPPED}`;

  function legacyCache(): SessionLocalCache {
    const cache = new SessionLocalCache();
    cache.setSession({
      sessionId: 'session-legacy',
      startedAt: 1,
      lastActivityAt: 4,
      totalTokens: 0,
      messages: [
        { id: 'legacy-1', role: 'user', content: RAW, timestamp: 1 },
        { id: 'legacy-1-answer', role: 'assistant', content: '收到，先做会员分层', timestamp: 2 },
        { id: 'plain-1', role: 'user', content: '普通提问：会员卡怎么升级', timestamp: 3 },
        { id: 'quoted-1', role: 'assistant', content: '【组队 · 产品规格】是旧版标签', timestamp: 4 },
      ],
    });
    return cache;
  }

  it('matches the user words with a clean snippet whose offsets index the stripped text', () => {
    const cache = legacyCache();
    const result = searchSessions('会员', { sessionIds: ['session-legacy'] }, cache);

    const hit = result.results.find((r) => r.message.id === 'legacy-1');
    expect(hit?.snippet).toBe('**会员**增长方案');
    expect(hit?.snippet).not.toContain('【组队 ·');
    expect(hit?.matches).toHaveLength(1);
    expect(hit?.matches[0].start).toBe(STRIPPED.indexOf('会员'));
    expect(hit?.matches[0].end).toBe(STRIPPED.indexOf('会员') + '会员'.length);
    // 只在搜索文本上剥：返回的 message 与缓存里的原行都不改写
    expect(hit?.message.content).toBe(RAW);
    expect(cache.getSession('session-legacy')?.messages[0].content).toBe(RAW);
  });

  it.each(['组队', '产品规格'])('returns no result for a query that only appears in the prefix (%s)', (query) => {
    const result = searchSessions(query, { sessionIds: ['session-legacy'] }, legacyCache());

    // 只剩 assistant 行里引用的同一串：前缀只在用户消息上剥
    expect(result.results.map((r) => r.message.id)).toEqual(['quoted-1']);
  });

  it('keeps messages without the prefix on their raw text', () => {
    const raw = '普通提问：会员卡怎么升级';
    const result = searchSessions('会员', { sessionIds: ['session-legacy'] }, legacyCache());

    const hit = result.results.find((r) => r.message.id === 'plain-1');
    expect(hit?.matches[0].start).toBe(raw.indexOf('会员'));
    expect(hit?.snippet).toBe('普通提问：**会员**卡怎么升级');
  });

  it('returns no result for a whole legacy orchestration brief row', () => {
    const cache = new SessionLocalCache();
    cache.setSession({
      sessionId: 'session-brief',
      startedAt: 1,
      lastActivityAt: 1,
      totalTokens: 0,
      messages: [{
        id: 'brief-1',
        role: 'user',
        content: `你是主理人。主题是 ${STRIPPED}\n执行铁律：第一步必须调用 spawn_agent；\nagents JSON：[{"role":"溯真"}]`,
        timestamp: 1,
      }],
    });

    const result = searchSessions('会员', { sessionIds: ['session-brief'] }, cache);

    expect(result.results).toEqual([]);
    expect(result.totalMatches).toBe(0);
  });
});
