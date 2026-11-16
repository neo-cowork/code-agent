// N-FIX-STALE-FAILURE-CARD-SHOWN-ON-NEW-TURN：终态 error 要带上「这一轮的用户消息 id」，
// renderer 才能把失败卡钉在失败那一轮（晚到的上一轮 error 不会挂到下一轮下面）。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Response } from 'express';

const sendSSE = vi.fn();
vi.mock('../../../src/web/helpers/sse', () => ({
  broadcastSSE: vi.fn(),
  sendSSE: (res: unknown, event: string, data: unknown) => sendSSE(res, event, data),
}));

const { AgentRunController } = await import('../../../src/web/routes/agentRunController');

function controller(turnUserMessageId?: string) {
  return new AgentRunController({
    res: { writableEnded: false, destroyed: false, write: () => true, end: () => undefined, once: () => undefined, off: () => undefined } as unknown as Response,
    runId: 'run-1',
    sessionId: 'session-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tryGetSessionManager: async () => null,
    mirrorToBroadcast: false,
    ...(turnUserMessageId ? { turnUserMessageId } : {}),
  });
}

function emittedErrorData(): { details?: Record<string, unknown> } {
  const call = sendSSE.mock.calls.find(([, event]) => event === 'error');
  expect(call).toBeDefined();
  return call![2] as { details?: Record<string, unknown> };
}

describe('AgentRunController 终态 error 盖轮次章', () => {
  beforeEach(() => sendSSE.mockClear());

  it('保留引擎给的 provider/model details，并补上本轮用户消息 id', () => {
    const c = controller('user-msg-1');
    c.emitAgentEvent({ type: 'error', data: { message: '鉴权失败', code: 'RUN_FAILED', details: { provider: 'zhipu', model: 'glm-5.3' } } });
    c.flush();
    expect(emittedErrorData().details).toEqual({ provider: 'zhipu', model: 'glm-5.3', turnUserMessageId: 'user-msg-1' });
  });

  it('引擎没带 details（catch 里裸发的 error）也要盖章', () => {
    const c = controller('user-msg-1');
    c.emitAgentEvent({ type: 'error', data: { message: '鉴权失败' } });
    c.flush();
    expect(emittedErrorData().details).toEqual({ turnUserMessageId: 'user-msg-1' });
  });

  it('请求没带 clientMessageId 时不编造轮次章', () => {
    const c = controller();
    c.emitAgentEvent({ type: 'error', data: { message: '鉴权失败' } });
    c.flush();
    expect(emittedErrorData().details).toBeUndefined();
  });
});
