// N-COMPANION-APPROVAL-DESKTOP-RESOLVED r2：审批应答的「未送达」信号必须穿过 HTTP
// transport。宿主（webPermissionResponseHandler）把迟到点击（手机已先答等）回报为
// HTTP 200 + {success:false, error:{code:'PENDING_PERMISSION_NOT_FOUND'}}；transport
// 曾把 success:false 一律坍缩成 undefined，renderer 的 isUndeliveredResponse(undefined)
// 恒 false——真链路上迟到点击会被记成本机决定。这里用**真 handler 产出线上 JSON +
// 真 httpTransport + 只 mock fetch** 钉住这个 seam。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// deliverForegroundPermissionResponse 的返回值按用例切换：undefined = 前台没有这条
// pending（落入 TaskManager 分支），'delivered' = 前台岛直接送达。
const foregroundOutcome = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock('../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => ({ handlePermissionResponse: () => 'unknown_request' }),
}));
vi.mock('../../../src/web/foregroundPermissionRegistry', () => ({
  deliverForegroundPermissionResponse: () => foregroundOutcome.value,
}));
vi.mock('../../../src/host/agent/parkedApprovalHydration', () => ({
  closeDeadParkedApproval: () => false,
}));
vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: { getState: () => ({ status: 'disconnected' }) },
}));
vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({ invokeTool: vi.fn() }),
}));

(globalThis as Record<string, unknown>).window = {
  __CODE_AGENT_TOKEN__: 'test-token',
};

import { useAppStore } from '../../../src/renderer/stores/appStore';
import { createHttpCodeAgentAPI, createHttpDomainAPI } from '../../../src/renderer/api/httpTransport';
import { takeTransportFailure } from '../../../src/renderer/api/transportFailures';
import { installPermissionResponseHandler } from '../../../src/web/webPermissionResponseHandler';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

function buildWebHandler() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  installPermissionResponseHandler({
    handlers,
    pendingDevPermissions: new Map(),
    getCurrentSessionId: () => 'session-late-click',
    logger: { info: () => {}, warn: () => {} },
  });
  const handler = handlers.get(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE);
  if (!handler) throw new Error('permission response handler not installed');
  return handler;
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => payload,
    text: async () => '',
  };
}

describe('httpTransport keeps the permission response delivery signal intact', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    foregroundOutcome.value = undefined;
  });

  it('an undelivered late click keeps the {success:false, error} envelope across the transport', async () => {
    const handler = buildWebHandler();
    // 真 handler 对 unknown request 的产出。注意这是 HTTP 200 + 业务失败信封，
    // 不是 HTTP 错误码——所以 transport 的 !response.ok 分支帮不上忙。
    const wireJson = await handler(null, 'req-late', 'allow', 'session-late-click');
    expect(wireJson).toMatchObject({ success: false, error: { code: 'PENDING_PERMISSION_NOT_FOUND' } });

    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(wireJson));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    const result = await api.invoke(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'req-late', 'allow', 'session-late-click');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8180/api/agent/permission-response');
    expect(init?.method).toBe('POST');
    // 位置参数按 Electron IPC 约定走数组 body，domain 兜底路由按数组展开回 handler。
    expect(JSON.parse(String(init?.body))).toEqual(['req-late', 'allow', 'session-late-click']);
    // 未送达信封必须活着到达 renderer（坍缩成 undefined 就是本单要堵的洞）。
    expect(result).toEqual(wireJson);
    expect(result).toMatchObject({ success: false, error: { code: 'PENDING_PERMISSION_NOT_FOUND' } });
  });

  it('a delivered response still unwraps to its data payload (desktop-first behaviour unchanged)', async () => {
    foregroundOutcome.value = 'delivered';
    const handler = buildWebHandler();
    const wireJson = await handler(null, 'req-ok', 'allow', 'session-late-click');
    expect(wireJson).toMatchObject({ success: true, data: { source: 'foreground-permission-island' } });

    globalThis.fetch = vi.fn(async () => jsonResponse(wireJson)) as unknown as typeof fetch;
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    const result = await api.invoke(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'req-ok', 'allow', 'session-late-click');

    expect(result).toEqual({
      requestId: 'req-ok',
      sessionId: 'session-late-click',
      source: 'foreground-permission-island',
    });
  });

  // N-APPROVAL-LANE-CLICK-DROP：传输故障（fetch 拒绝 / 非 2xx / token 失效 / 非 JSON）
  // 对审批应答通道必须 REJECT——坍缩成 undefined 会让 PermissionCard 把失败点击当
  // 已送达处理（FB-419：卡消失、宿主等到超时否认）。transport failure 登记照旧保留。
  it('a fetch exception rejects for the permission channel and still records the transport failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await expect(
      api.invoke(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'req-net', 'allow', 'session-late-click'),
    ).rejects.toThrow('Failed to fetch');
    expect(takeTransportFailure(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE)).toMatchObject({ status: null });
  });

  it('a non-ok HTTP status rejects for the permission channel and records the status', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: 'boom' }),
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await expect(
      api.invoke(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'req-500', 'allow', 'session-late-click'),
    ).rejects.toMatchObject({ message: 'Neo 暂时无法完成请求，请稍后重试。', status: 500 });
    expect(takeTransportFailure(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE)).toMatchObject({ status: 500 });
  });

  it('a local auth-token expiry rejects for the permission channel instead of collapsing to undefined', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { message: 'Invalid auth token' } }),
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await expect(
      api.invoke(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'req-401', 'allow', 'session-late-click'),
    ).rejects.toThrow('Invalid auth token');
    expect(takeTransportFailure(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE)).toMatchObject({ status: null });
  });

  it('a 200 non-JSON body rejects for the permission channel and records the failure', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => '<html>gateway error page</html>',
      json: async () => {
        throw new Error('not json');
      },
    })) as unknown as typeof fetch;
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    await expect(
      api.invoke(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'req-html', 'allow', 'session-late-click'),
    ).rejects.toThrow('非 JSON');
    expect(takeTransportFailure(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE)).toMatchObject({ status: 200 });
  });

  it('every other channel keeps the silent undefined collapse on transport failure', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: 'boom' }),
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const api = createHttpCodeAgentAPI('http://localhost:8180');

    // session:list 是普通通道的代表：失败依旧 resolve undefined（改动面只限审批应答）。
    const result = await api.invoke('session:list');
    expect(result).toBeUndefined();
  });
});

const messages = {
  zh: 'Neo 暂时无法完成请求，请稍后重试。',
  en: 'Neo could not complete the request; please try again in a moment.',
};
const bodies = [
  '<html><pre>INTERNAL_PRIVATE_STACK /private/server.ts</pre></html>',
  JSON.stringify({ error: { message: 'INTERNAL_PRIVATE_STACK /private/server.ts', code: 'INTERNAL_SERVER_ERROR' } }),
  '',
];

describe('public HTTP send failure copy', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { __CODE_AGENT_TOKEN__: 'local-token' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useAppStore.setState({ language: 'zh' });
  });

  for (const language of ['zh', 'en'] as const) {
    for (const [index, body] of bodies.entries()) {
      it(`${language} maps body ${index} to a sentence and preserves HTTP metadata`, async () => {
        useAppStore.setState({ language });
        const fetch = vi.fn(async () => new Response(body, { status: 500 }));
        vi.stubGlobal('fetch', fetch);
        const api = createHttpCodeAgentAPI('http://localhost:8180');
        await expect(api.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, {
          content: '帮我把下载文件夹里的照片按日期改名', sessionId: 'photos',
        })).rejects.toMatchObject({ message: messages[language], status: 500,
          ...(index === 1 ? { code: 'INTERNAL_SERVER_ERROR' } : {}) });
        expect(fetch.mock.calls).toHaveLength(1);
        expect(fetch.mock.calls[0]).toMatchObject([
          'http://localhost:8180/api/run',
          { method: 'POST', body: JSON.stringify({ prompt: '帮我把下载文件夹里的照片按日期改名', sessionId: 'photos' }) },
        ]);
      });
    }
  }

  it.each<[number, string]>([
    [400, '这次请求无法处理，请调整内容后重试。'],
    [403, '这次操作未获授权，请检查访问权限后重试。'],
    [409, 'Neo 暂时无法接收请求，请稍后重试。'],
    [413, '发送的内容太大，请减少附件或内容后重试。'],
    [429, 'Neo 暂时无法接收请求，请稍后重试。'],
    [503, messages.zh],
  ])('maps status %s without exposing its JSON message', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'PRIVATE' }), { status })));
    await expect(createHttpCodeAgentAPI('').invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, '照片改名'))
      .rejects.toMatchObject({ status, message });
  });

  it('preserves only the typed missing-identity confirmation token on send errors', async () => {
    const recoveryToken = '11111111-1111-4111-8111-111111111111';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'PRIVATE', code: 'PROJECT_SOURCE_IDENTITY_CONFIRM_REQUIRED', recoveryToken,
    }), { status: 422 })));
    await expect(createHttpCodeAgentAPI('').invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, '照片改名'))
      .rejects.toMatchObject({ status: 422, code: 'PROJECT_SOURCE_IDENTITY_CONFIRM_REQUIRED', recoveryToken,
        message: '此文件夹需要重新确认，请确认信任后继续发送。' });
  });

  it('keeps a project trust refusal actionable without granting access', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'Project Source trust identity changed: PRIVATE', code: 'PROJECT_SOURCE_TRUST',
    }), { status: 422 })));
    await expect(createHttpCodeAgentAPI('').invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, '照片改名'))
      .rejects.toMatchObject({ status: 422, code: 'PROJECT_SOURCE_TRUST',
        message: '项目文件夹需要重新确认，请在项目设置中检查并信任该文件夹后重试。' });
  });

  it('covers domain, upload, generic invoke and permission failure consumers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bodies[0], { status: 500 })));
    const api = createHttpCodeAgentAPI('');
    await expect(createHttpDomainAPI('').invoke('settings', 'get')).resolves.toMatchObject({
      success: false, error: { code: 'HTTP_500', message: messages.zh },
    });
    await expect(api.getPathForFile(new File(['photo'], 'photo.png'))).rejects.toMatchObject({ status: 500, message: messages.zh });
    await expect(api.transcribeSpeech('audio', 'audio/wav')).resolves.toMatchObject({ success: false, error: messages.zh });
    await api.invoke(IPC_CHANNELS.SETTINGS_GET);
    expect(takeTransportFailure(IPC_CHANNELS.SETTINGS_GET)?.message).toBe(messages.zh);
    await expect(api.invoke(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, 'permission', 'allow', 'photos'))
      .rejects.toThrow(messages.zh);
  });
});
