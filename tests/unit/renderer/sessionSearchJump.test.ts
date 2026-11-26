import { describe, expect, it } from 'vitest';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import {
  createPendingSearchJumpFromCrossSessionResult,
  findSearchMatchForPendingJump,
  getTraceNodeSearchText,
} from '../../../src/renderer/utils/sessionSearchJump';

function projection(): TraceProjection {
  return {
    sessionId: 'session-1',
    activeTurnIndex: -1,
    turns: [
      {
        turnNumber: 1,
        turnId: 'turn-1',
        status: 'completed',
        startTime: 1,
        nodes: [
          {
            id: 'user-1',
            type: 'user',
            content: 'Start the project',
            timestamp: 1,
          },
          {
            id: 'assistant-1-text',
            messageId: 'assistant-1',
            type: 'assistant_text',
            content: 'First part mentions artifacts but has no target.',
            timestamp: 2,
          },
          {
            id: 'assistant-1-text-2',
            messageId: 'assistant-1',
            type: 'assistant_text',
            content: 'Second part contains needle here.',
            timestamp: 2,
          },
        ],
      },
      {
        turnNumber: 2,
        turnId: 'turn-2',
        status: 'completed',
        startTime: 3,
        nodes: [
          {
            id: 'user-2',
            type: 'user',
            content: 'Follow up on artifacts',
            timestamp: 3,
          },
        ],
      },
    ],
  };
}

describe('sessionSearchJump', () => {
  it('builds a pending jump from a cross-session search result', () => {
    expect(createPendingSearchJumpFromCrossSessionResult({
      sessionId: 'session-2',
      sessionTitle: 'Prior work',
      messageId: 'message-9',
      messageIndex: 8,
      turnNumber: 4,
      role: 'assistant',
      snippet: 'matched text',
      timestamp: 123,
      matchOffset: 17,
      matchCount: 2,
      relevance: 0.8,
    }, '  Needle  ', 999)).toEqual({
      sessionId: 'session-2',
      messageId: 'message-9',
      messageIndex: 8,
      turnNumber: 4,
      matchOffset: 17,
      query: 'Needle',
      createdAt: 999,
    });
  });

  it('finds the node containing the query inside a split assistant message', () => {
    expect(findSearchMatchForPendingJump(projection(), {
      sessionId: 'session-1',
      messageId: 'assistant-1',
      matchOffset: 42,
      query: 'needle',
      createdAt: 10,
    })).toEqual({ turnIndex: 0, nodeIndex: 2, offset: 21 });
  });

  it('falls back to the matching message node when the query is unavailable', () => {
    expect(findSearchMatchForPendingJump(projection(), {
      sessionId: 'session-1',
      messageId: 'assistant-1',
      query: 'missing',
      createdAt: 10,
    })).toEqual({ turnIndex: 0, nodeIndex: 1, offset: 0 });
  });

  it('uses message id lookup before query-only lookup', () => {
    expect(findSearchMatchForPendingJump(projection(), {
      sessionId: 'session-1',
      messageId: 'user-2',
      query: 'artifacts',
      createdAt: 10,
    })).toEqual({ turnIndex: 1, nodeIndex: 0, offset: 13 });
  });

  it('uses the searched turn number before global query lookup when message id is unavailable', () => {
    expect(findSearchMatchForPendingJump(projection(), {
      sessionId: 'session-1',
      turnNumber: 2,
      query: 'artifacts',
      createdAt: 10,
    })).toEqual({ turnIndex: 1, nodeIndex: 0, offset: 13 });
  });

  it('rejects jumps for a different session', () => {
    expect(findSearchMatchForPendingJump(projection(), {
      sessionId: 'other-session',
      query: 'needle',
      createdAt: 10,
    })).toBeNull();
  });

  it('finds a query that only exists in a tool call result (tool node content is empty)', () => {
    const proj = projection();
    proj.turns[1].nodes.push({
      id: 'tool-1',
      messageId: 'assistant-2',
      type: 'tool_call',
      content: '',
      timestamp: 4,
      toolCall: { id: 'call-1', name: 'Read', args: {}, result: 'Supplier code: ZK-4471-QUARTZ' },
    });
    expect(findSearchMatchForPendingJump(proj, {
      sessionId: 'session-1',
      messageId: 'tool-message-id-not-in-projection',
      query: 'zk-4471-quartz',
      createdAt: 10,
    })).toMatchObject({ turnIndex: 1, nodeIndex: 1 });
  });
});

// 旧组队配方行：用户消息以「【组队 · 配方名】」开头（气泡已剥掉前缀，legacyTeamRecipeDisplay.ts），
// 会话内搜索计数与跳转定位同口径
describe('sessionSearchJump — legacy team-recipe prefix on user nodes', () => {
  const STRIPPED = '会员增长方案';

  function legacyProjection(): TraceProjection {
    const proj = projection();
    proj.turns[0].nodes.push({
      id: 'user-legacy',
      type: 'user',
      content: `【组队 · 产品规格】${STRIPPED}`,
      timestamp: 4,
    });
    return proj;
  }

  it('finds the node text without the legacy prefix', () => {
    const proj = legacyProjection();

    expect(getTraceNodeSearchText(proj.turns[0].nodes[3])).toBe(STRIPPED);
    expect(proj.turns[0].nodes[3].content).toBe(`【组队 · 产品规格】${STRIPPED}`);
  });

  it('computes the jump offset on the text without the legacy prefix', () => {
    const match = findSearchMatchForPendingJump(legacyProjection(), {
      sessionId: 'session-1',
      messageId: 'user-legacy',
      matchOffset: -1,
      query: '增长方案',
      createdAt: 10,
    });

    // 原文里「增长方案」从第 13 位开始；剥掉前缀后从第 2 位开始
    expect(match).toEqual({ turnIndex: 0, nodeIndex: 3, offset: STRIPPED.indexOf('增长方案') });
  });

  it('does not match a query that only appears in the legacy prefix', () => {
    const proj = legacyProjection();

    // 按消息 id：查询词在节点里找不到 → 回落到节点开头，不落进前缀（原文里「组队」在第 1 位）
    expect(findSearchMatchForPendingJump(proj, {
      sessionId: 'session-1',
      messageId: 'user-legacy',
      query: '组队',
      createdAt: 10,
    })).toEqual({ turnIndex: 0, nodeIndex: 3, offset: 0 });

    // 按轮次 / 全局查词：该节点不参与匹配
    expect(findSearchMatchForPendingJump(proj, {
      sessionId: 'session-1',
      turnNumber: 1,
      query: '组队',
      createdAt: 10,
    })).toBeNull();
    expect(findSearchMatchForPendingJump(proj, {
      sessionId: 'session-1',
      query: '产品规格',
      createdAt: 10,
    })).toBeNull();
  });

  it('gives a whole legacy brief node no searchable text', () => {
    const proj = legacyProjection();
    proj.turns[0].nodes[3].content = `你是主理人。主题是 ${STRIPPED}\n执行铁律：第一步必须调用 spawn_agent；\nagents JSON：[{"role":"溯真"}]`;

    expect(getTraceNodeSearchText(proj.turns[0].nodes[3])).toBe('');
    expect(findSearchMatchForPendingJump(proj, {
      sessionId: 'session-1',
      turnNumber: 1,
      query: '会员',
      createdAt: 10,
    })).toBeNull();
  });
});
