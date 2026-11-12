// ============================================================================
// HttpTransport ↔ ServerConnectionMonitor 接线（N-WEBSERVER-DEATH-SUPERVISE-BANNER）
// ============================================================================
// 三个触发口（SSE onerror / invoke 网络失败 / /api/run 网络失败）与两条红线：
// HTTP 4xx/5xx 不触发监视器；横幅在（state != ok）时 /api/run 的网络失败给人话
// 文案而不是 WebKit 的裸 `TypeError: Load failed`。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { WEB_SERVER_CONNECTION_MONITOR } from '../../../src/shared/constants';

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: {
    getState: () => ({ status: 'disconnected' }),
  },
}));
vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({
    invokeTool: vi.fn(),
  }),
}));

const fetchMock = vi.fn();
const reloadSpy = vi.fn();

type TransportModule = typeof import('../../../src/renderer/api/httpTransport');

async function loadModules(): Promise<{
  createHttpCodeAgentAPI: TransportModule['createHttpCodeAgentAPI'];
  status: () => string;
}> {
  const { createHttpCodeAgentAPI } = await import('../../../src/renderer/api/httpTransport');
  const store = await import('../../../src/renderer/stores/serverConnectionStore');
  return {
    createHttpCodeAgentAPI,
    status: () => store.useServerConnectionStore.getState().status,
  };
}

/** 网络失败的 fetch（fetch 拒绝、无 HTTP 响应）；/api/health 单独可控。 */
function installNetworkDownFetch(healthReachable = false): void {
  fetchMock.mockImplementation(async (input: unknown) => {
    if (String(input).includes('/api/health') && healthReachable) {
      return { ok: true, status: 200 } as unknown as Response;
    }
    throw new TypeError('Load failed');
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function healthProbeCalls(): unknown[][] {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/health'));
}

describe('httpTransport → serverConnectionMonitor 接线', () => {
  let originalWindow: unknown;
  let originalFetch: unknown;
  let originalEventSource: unknown;
  let originalLocalStorage: unknown;
  let sseInstances: Array<{ onerror: (() => void) | null; close: () => void }>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    reloadSpy.mockClear();
    fetchMock.mockReset();
    originalWindow = (globalThis as Record<string, unknown>).window;
    originalFetch = (globalThis as Record<string, unknown>).fetch;
    originalEventSource = (globalThis as Record<string, unknown>).EventSource;
    originalLocalStorage = (globalThis as Record<string, unknown>).localStorage;
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    (globalThis as Record<string, unknown>).window = {
      __CODE_AGENT_TOKEN__: undefined,
      location: { search: '', origin: 'http://localhost:8180', reload: reloadSpy },
    };
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => null,
      setItem: () => {},
    };
    // 与 sseReconnect 测试同款 EventSource 桩，只保留 onerror/close
    sseInstances = [];
    (globalThis as Record<string, unknown>).EventSource = function (this: {
      onerror: (() => void) | null; close: () => void;
    }) {
      this.onerror = null;
      this.close = () => {};
      sseInstances.push(this);
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as Record<string, unknown>).window = originalWindow;
    (globalThis as Record<string, unknown>).fetch = originalFetch;
    (globalThis as Record<string, unknown>).EventSource = originalEventSource;
    (globalThis as Record<string, unknown>).localStorage = originalLocalStorage;
  });

  it('invoke 网络失败（fetch 拒绝）触发 /api/health 探测；探测成功则不出横幅不刷新', async () => {
    installNetworkDownFetch(true); // 业务端点全挂，但服务进程活着（health 可达）
    const { createHttpCodeAgentAPI, status } = await loadModules();
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await expect(api.invoke(IPC_CHANNELS.SETTINGS_GET)).resolves.toBeUndefined();
    expect(status()).toBe('ok');

    await vi.advanceTimersByTimeAsync(0); // 首发探测
    expect(healthProbeCalls()).toHaveLength(1);
    expect(String(healthProbeCalls()[0][0])).toBe('http://localhost:8180/api/health');
    await vi.advanceTimersByTimeAsync(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS * 2);
    expect(status()).toBe('ok');
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('invoke 收到 HTTP 500（有 HTTP 响应）不触发连接监视器', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).includes('/api/health')) {
        throw new Error('probe should not happen');
      }
      return jsonResponse(500, { error: { message: 'boom' } });
    });
    const { createHttpCodeAgentAPI, status } = await loadModules();
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await api.invoke(IPC_CHANNELS.SETTINGS_GET);
    await vi.advanceTimersByTimeAsync(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS * 3);
    expect(healthProbeCalls()).toHaveLength(0);
    expect(status()).toBe('ok');
  });

  it('SSE onerror 触发探测：连续失败出 recovering，随后恢复回 ok 且恰好 reload 一次', async () => {
    installNetworkDownFetch(false);
    const { createHttpCodeAgentAPI, status } = await loadModules();
    const api = createHttpCodeAgentAPI('http://localhost:8180');
    api.on('swarm:event', () => {});
    expect(sseInstances).toHaveLength(1);

    sseInstances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(0); // 探测失败 #1
    expect(status()).toBe('ok');
    await vi.advanceTimersByTimeAsync(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS); // #2
    expect(status()).toBe('recovering');
    expect(reloadSpy).not.toHaveBeenCalled();

    // 服务被壳拉起来了：探测成功 → ok + 一次 reload（新 boot/auth 状态）
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200 }) as unknown as Response);
    await vi.advanceTimersByTimeAsync(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
    expect(status()).toBe('ok');
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('/api/run 网络失败在 recovering 态抛人话文案，而不是裸 Load failed', async () => {
    installNetworkDownFetch(false);
    const { createHttpCodeAgentAPI, status } = await loadModules();
    const api = createHttpCodeAgentAPI('http://localhost:8180');
    api.on('swarm:event', () => {});
    sseInstances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
    expect(status()).toBe('recovering');

    let thrown: Error | undefined;
    try {
      await api.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, '你好');
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain('正在重新连接后台服务');
    expect(thrown?.message).not.toContain('Load failed');
  });

  it('/api/run 网络失败在 ok 态（阈值未到）原样上抛原始错误', async () => {
    installNetworkDownFetch(false);
    const { createHttpCodeAgentAPI, status } = await loadModules();
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await expect(api.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, '你好')).rejects.toThrow('Load failed');
    expect(status()).toBe('ok'); // 探测刚起步，还没到出横幅的阈值
  });

  // N-FIX-SIGNED-OUT-SEND-500-RAW-HTML-REDESIGN：服务端未兜住时 /api/run 会回整页
  // HTML 500——transport 只按 status/code 出一句话人话，HTML/内部报错文本永远不进 message。
  it('/api/run 5xx HTML 错误页只抛一句话人话，响应体一个字都不进 message', async () => {
    const htmlBody = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Error</title></head><body><pre>Error: Project Source trust identity changed</pre></body></html>';
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).includes('/api/health')) {
        return jsonResponse(200, { status: 'ok' });
      }
      return new Response(htmlBody, { status: 500, headers: { 'content-type': 'text/html' } });
    });
    const { createHttpCodeAgentAPI } = await loadModules();
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    let thrown: Error & { status?: number; code?: string } | undefined;
    try {
      await api.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, '帮我把下载文件夹里的照片按日期改名');
    } catch (err) {
      thrown = err as Error & { status?: number; code?: string };
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toBe('Neo 暂时没能完成这次请求，请稍后再试。');
    expect(thrown?.message).not.toMatch(/云端代理|Error|&lt;|DOCTYPE|trust identity|500/);
    expect(thrown?.status).toBe(500);
  });

  // 同类位置（rework r1）：domain invoke 的 !ok 信封此前把响应体原样塞进 error.message，
  // invokeDomain 再包成 DomainInvokeError.message 进 toast/气泡。
  it('domain invoke 非 2xx：信封保留 HTTP_<status>，message 只有一句话人话，不含响应体', async () => {
    const htmlBody = '<!DOCTYPE html><html lang="en"><head><title>Error</title></head><body><pre>Error: Project sources overlap: /Users/me/photos<br> &nbsp; at ProjectService.getWorkspaceScope (webServer.cjs:174730:34)</pre></body></html>';
    const bodies: Array<[string, number, string, string]> = [
      ['list', 500, htmlBody, 'text/html'],
      ['create', 500, JSON.stringify({ success: false, error: { code: 'HANDLER_ERROR', message: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: projects.id' } }), 'application/json'],
      ['archive', 404, JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'No handler for domain:project action:archive' } }), 'application/json'],
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { createHttpDomainAPI } = await import('../../../src/renderer/api/httpTransport');
    const api = createHttpDomainAPI('http://localhost:8180');

    for (const [action, status, body, contentType] of bodies) {
      fetchMock.mockImplementation(async () => new Response(body, { status, headers: { 'content-type': contentType } }));
      const response = await api.invoke('domain:project', action);
      expect(response).toEqual({
        success: false,
        error: { code: `HTTP_${status}`, message: 'Neo 暂时没能完成这次请求，请稍后再试。' },
      });
      // 原始响应体只进诊断日志，不丢
      expect(warn.mock.calls.some((call) => call.includes(body))).toBe(true);
    }

    // 服务端信任门的 code 仍按 code-first 给出信任句，不落回通用句
    fetchMock.mockImplementation(async () => jsonResponse(422, { error: 'Project folder needs trust confirmation', code: 'PROJECT_SOURCE_TRUST', kind: 'identity_changed' }));
    await expect(api.invoke('domain:project', 'get')).resolves.toEqual({
      success: false,
      error: { code: 'HTTP_422', message: '这个项目文件夹需要你确认后 Neo 才能使用。' },
    });
    warn.mockRestore();
  });

  // 域协议自己的业务错误信封（error.message，且不带路由故障位）是 handler 写给用户的答复，
  // 非 2xx 时与 200 + success:false 同等对待；非信封 JSON / 路由故障位仍只出一句话。
  it('domain invoke 非 2xx：业务错误信封的 message 原样保留，非信封与路由故障位不保留', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { createHttpDomainAPI } = await import('../../../src/renderer/api/httpTransport');
    const api = createHttpDomainAPI('http://localhost:8180');
    const generic = 'Neo 暂时没能完成这次请求，请稍后再试。';
    const cases: Array<[number, unknown, string]> = [
      [400, { success: false, error: { code: 'SESSION_TITLE_TOO_LONG', message: '会话名称太长了，请控制在 60 字以内' } }, '会话名称太长了，请控制在 60 字以内'],
      [500, { error: { message: 'Business failure' } }, 'Business failure'],
      [403, { success: false, error: { code: 'FORBIDDEN', message: 'Admin: Admin permission required' } }, '本地服务没有接受这次请求，请刷新页面后重试。'],
      [500, { error: 'Local server request failed', code: 'INTERNAL_SERVER_ERROR' }, generic],
      [404, { error: 'Unknown channel: project:archive' }, generic],
      [500, { success: false, error: { code: 'SESSION_WRITE_FAILED', message: '   ' } }, generic],
    ];
    for (const [status, body, message] of cases) {
      fetchMock.mockImplementation(async () => jsonResponse(status, body));
      await expect(api.invoke('domain:session', 'create')).resolves.toEqual({
        success: false,
        error: { code: `HTTP_${status}`, message },
      });
    }
  });

  // message 净化后，按 message 认「域路由没有该 handler」的调用方改认 HTTP_404 这个 code：
  // 走真实链路 transport → ipcService.invokeDomain → tagClient。
  it('domain 路由 404（没有 handler）经 invokeDomain 仍被 tagClient 认作「Tag IPC 不可用」', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async () => jsonResponse(404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'No handler for domain:tag action:listAll' },
    }));
    const { createHttpDomainAPI } = await import('../../../src/renderer/api/httpTransport');
    window.domainAPI = createHttpDomainAPI('http://localhost:8180');
    const { tagClient, isNeoTagIpcUnavailableError } = await import('../../../src/renderer/services/tagClient');

    const error = await tagClient.listAll().catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'HTTP_404', message: 'Neo 暂时没能完成这次请求，请稍后再试。' });
    expect(isNeoTagIpcUnavailableError(error)).toBe(true);
    // 真故障（handler 抛错的 500）不能被吞成「不可用」
    fetchMock.mockImplementation(async () => jsonResponse(500, { success: false, error: { code: 'HANDLER_ERROR', message: 'boom' } }));
    const failure = await tagClient.listByProject({ projectId: 'p1' }).catch((err: unknown) => err);
    expect(isNeoTagIpcUnavailableError(failure)).toBe(false);
  });
});
