// @vitest-environment jsdom
// 401 auth-token 恢复路径会排一个 250ms 的 reload 定时器；jsdom 环境先于定时器被拆掉时，
// 回调里的 window 变成未声明全局，抛 ReferenceError 让 vitest shard 随机变红。
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: { getState: () => ({ status: 'disconnected' }) },
}));
vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({ invokeTool: vi.fn() }),
}));

import { createHttpCodeAgentAPI, createHttpDomainAPI } from '../../../src/renderer/api/httpTransport';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

describe('httpTransport auth-token reload timer', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    window.sessionStorage.clear();
  });

  it('does not throw when the window global is gone before the reload timer fires', async () => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { message: 'Invalid auth token' } }),
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await expect(
      api.invoke(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'req-401', 'allow', 'session-x'),
    ).rejects.toThrow('Invalid auth token');

    // 模拟环境拆除：定时器还没触发，window 已不存在
    vi.stubGlobal('window', undefined);
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
  });
  it('does not re-arm automatic reload after an unrelated successful request', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(window, 'setTimeout');
    const reloadTimers = () => timeout.mock.calls.filter(([, delay]) => delay === 250).length;
    const api = createHttpDomainAPI('http://localhost:8180');
    const denied = () => new Response(JSON.stringify({ error: { message: 'Missing or invalid Authorization header' } }), { status: 401 });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }))
      .mockResolvedValueOnce(denied());
    await expect(api.invoke('session', 'list')).resolves.toMatchObject({ success: false, error: { code: 'LOCAL_AUTH_TOKEN_EXPIRED' } });
    const timersAfterFailure = reloadTimers();
    expect(timersAfterFailure).toBe(1);
    await api.invoke('auth', 'getStatus');
    await api.invoke('session', 'list');
    expect(reloadTimers()).toBe(timersAfterFailure);
    expect(window.sessionStorage.getItem('code-agent:http-auth-token-reload-attempted')).toBe('1');
  });

});
