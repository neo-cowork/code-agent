// ============================================================================
// Send-failure bubble matrix (N-FIX-ATTACHMENT-ONLY-SEND-MISSING-PROMPT-FU1-FAILURE-COPY-CHECK)
// ============================================================================
// Exercises the production path: stub fetch for `/api/run` inside
// `createHttpCodeAgentAPI` -> catch the thrown error -> feed it to
// `getAgentSendFailureMessage`, in both `zh` and `en`.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const SENTINEL = 'SENTINEL_SERVER_ENGLISH_BODY_9821';
const CJK_RE = /[\u4e00-\u9fff]/;

interface MatrixCase {
  id: string;
  run: (ctx: {
    invokeSend: () => Promise<unknown>;
    driveConnectionRecovering: () => Promise<void>;
  }) => Promise<{ error: unknown; expectedRawInWarn: string | null }>;
  expected: { zh: string; en: string };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function htmlResponse(status: number, title: string): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><title>${title}</title></head><body><pre>${SENTINEL}</pre></body></html>`,
    { status, headers: { 'content-type': 'text/html' } },
  );
}

const MATRIX_CASES: MatrixCase[] = [
  {
    id: '400 PROMPT_REQUIRED',
    run: async ({ invokeSend }) => {
      fetchMock.mockImplementation(async () =>
        jsonResponse(400, { error: `Missing prompt ${SENTINEL}`, code: 'PROMPT_REQUIRED' }),
      );
      const error = await invokeSend().catch((e: unknown) => e);
      return { error, expectedRawInWarn: SENTINEL };
    },
    expected: {
      zh: '请补一句话说明想让我做什么，然后再发送一次。',
      en: 'Add a sentence saying what you want done, then send again.',
    },
  },
  {
    id: '401 Invalid auth token',
    run: async ({ invokeSend }) => {
      fetchMock.mockImplementation(async () =>
        jsonResponse(401, { error: `Invalid auth token ${SENTINEL}` }),
      );
      const error = await invokeSend().catch((e: unknown) => e);
      return { error, expectedRawInWarn: `Invalid auth token ${SENTINEL}` };
    },
    expected: {
      zh: '本地服务没有接受这次请求，请刷新页面后重试。',
      en: 'The local session could not be verified. Refresh the page and try again.',
    },
  },
  {
    id: '401 plain HTML page',
    run: async ({ invokeSend }) => {
      fetchMock.mockImplementation(async () => htmlResponse(401, 'Unauthorized'));
      const error = await invokeSend().catch((e: unknown) => e);
      return { error, expectedRawInWarn: SENTINEL };
    },
    expected: {
      zh: '本地服务没有接受这次请求，请刷新页面后重试。',
      en: 'The local session could not be verified. Refresh the page and try again.',
    },
  },
  {
    id: '403 Invalid auth token',
    run: async ({ invokeSend }) => {
      fetchMock.mockImplementation(async () =>
        jsonResponse(403, { error: `Invalid auth token ${SENTINEL}` }),
      );
      const error = await invokeSend().catch((e: unknown) => e);
      return { error, expectedRawInWarn: `Invalid auth token ${SENTINEL}` };
    },
    expected: {
      zh: '本地服务没有接受这次请求，请刷新页面后重试。',
      en: 'The local session could not be verified. Refresh the page and try again.',
    },
  },
  {
    id: '403 plain HTML page',
    run: async ({ invokeSend }) => {
      fetchMock.mockImplementation(async () => htmlResponse(403, 'Forbidden'));
      const error = await invokeSend().catch((e: unknown) => e);
      return { error, expectedRawInWarn: SENTINEL };
    },
    expected: {
      zh: '本地服务没有接受这次请求，请刷新页面后重试。',
      en: 'The local session could not be verified. Refresh the page and try again.',
    },
  },
  {
    id: '409 busy',
    run: async ({ invokeSend }) => {
      fetchMock.mockImplementation(async () =>
        jsonResponse(409, { error: `Session already has active run ${SENTINEL}`, code: 'RUN_CONFLICT' }),
      );
      const error = await invokeSend().catch((e: unknown) => e);
      return { error, expectedRawInWarn: SENTINEL };
    },
    expected: {
      zh: '上一轮还没结束，请稍候再发送。',
      en: 'The previous turn is still finishing. Try again in a moment.',
    },
  },
  {
    id: '422 PROJECT_SOURCE_TRUST',
    run: async ({ invokeSend }) => {
      fetchMock.mockImplementation(async () =>
        jsonResponse(422, {
          error: `Project folder needs trust confirmation ${SENTINEL}`,
          code: 'PROJECT_SOURCE_TRUST',
          kind: 'identity_changed',
        }),
      );
      const error = await invokeSend().catch((e: unknown) => e);
      return { error, expectedRawInWarn: SENTINEL };
    },
    expected: {
      zh: '这个项目文件夹需要你确认后 Neo 才能使用。',
      en: 'This project folder needs your confirmation before Neo can use it.',
    },
  },
  {
    id: '429 rate limited',
    run: async ({ invokeSend }) => {
      fetchMock.mockImplementation(async () =>
        jsonResponse(429, { error: `Too many requests ${SENTINEL}`, code: 'TOO_MANY_CONNECTIONS' }),
      );
      const error = await invokeSend().catch((e: unknown) => e);
      return { error, expectedRawInWarn: SENTINEL };
    },
    expected: {
      zh: '发送太频繁了，请稍等片刻再重试。',
      en: 'Too many requests in a short time. Wait a moment and try again.',
    },
  },
  {
    id: '500 HTML body',
    run: async ({ invokeSend }) => {
      fetchMock.mockImplementation(async () => htmlResponse(500, 'Internal Server Error'));
      const error = await invokeSend().catch((e: unknown) => e);
      return { error, expectedRawInWarn: SENTINEL };
    },
    expected: {
      zh: 'Neo 暂时没能完成这次请求，请稍后再试。',
      en: 'Neo could not complete the request; please try again in a moment.',
    },
  },
  {
    id: '503 plain',
    run: async ({ invokeSend }) => {
      fetchMock.mockImplementation(async () =>
        new Response(`Service Unavailable ${SENTINEL}`, {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        }),
      );
      const error = await invokeSend().catch((e: unknown) => e);
      return { error, expectedRawInWarn: SENTINEL };
    },
    expected: {
      zh: 'Neo 暂时没能完成这次请求，请稍后再试。',
      en: 'Neo could not complete the request; please try again in a moment.',
    },
  },
  {
    id: '503 DURABLE_RUN_ROLLOUT_UNAVAILABLE',
    run: async ({ invokeSend }) => {
      fetchMock.mockImplementation(async () =>
        jsonResponse(503, {
          error: `Durable run rollout unavailable ${SENTINEL}`,
          code: 'DURABLE_RUN_ROLLOUT_UNAVAILABLE',
        }),
      );
      const error = await invokeSend().catch((e: unknown) => e);
      return { error, expectedRawInWarn: SENTINEL };
    },
    expected: {
      zh: 'Neo 暂时没能完成这次请求，请稍后再试。',
      en: 'Neo could not complete the request; please try again in a moment.',
    },
  },
  {
    id: 'fetch rejection TypeError(Load failed) with connection ok',
    run: async ({ invokeSend }) => {
      fetchMock.mockImplementation(async () => {
        throw new TypeError('Load failed');
      });
      const error = await invokeSend().catch((e: unknown) => e);
      return { error, expectedRawInWarn: 'Load failed' };
    },
    expected: {
      zh: 'Neo 暂时没能完成这次请求，请稍后再试。',
      en: 'Neo could not complete the request; please try again in a moment.',
    },
  },
  {
    id: 'fetch rejection TypeError(Load failed) with connection not ok',
    run: async ({ invokeSend, driveConnectionRecovering }) => {
      fetchMock.mockImplementation(async () => {
        throw new TypeError('Load failed');
      });
      await driveConnectionRecovering();
      const error = await invokeSend().catch((e: unknown) => e);
      return { error, expectedRawInWarn: 'Load failed' };
    },
    expected: {
      zh: '正在重新连接后台服务，请稍后再试',
      en: 'Reconnecting to the background service — please try again in a moment',
    },
  },
  {
    id: 'undefined',
    run: async () => ({ error: undefined, expectedRawInWarn: 'undefined' }),
    expected: {
      zh: 'Neo 暂时没能完成这次请求，请稍后再试。',
      en: 'Neo could not complete the request; please try again in a moment.',
    },
  },
];

describe('httpTransport /api/run -> getAgentSendFailureMessage matrix', () => {
  let originalWindow: unknown;
  let originalFetch: unknown;
  let originalEventSource: unknown;
  let originalLocalStorage: unknown;
  let originalSessionStorage: unknown;
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
    originalSessionStorage = (globalThis as Record<string, unknown>).sessionStorage;
    const sessionStore = new Map<string, string>();
    const sessionStorageStub = {
      getItem: (key: string) => sessionStore.get(key) ?? null,
      setItem: (key: string, val: string) => { sessionStore.set(key, val); },
      removeItem: (key: string) => { sessionStore.delete(key); },
      clear: () => { sessionStore.clear(); },
    };
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    (globalThis as Record<string, unknown>).sessionStorage = sessionStorageStub;
    (globalThis as Record<string, unknown>).window = {
      __CODE_AGENT_TOKEN__: 'stale-token',
      location: { search: '', origin: 'http://localhost:8180', reload: reloadSpy },
      sessionStorage: sessionStorageStub,
      setTimeout: globalThis.setTimeout.bind(globalThis),
    };
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => null,
      setItem: () => {},
    };
    sseInstances = [];
    (globalThis as Record<string, unknown>).EventSource = function (this: {
      onerror: (() => void) | null;
      close: () => void;
    }) {
      this.onerror = null;
      this.close = () => {};
      sseInstances.push(this);
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    (globalThis as Record<string, unknown>).window = originalWindow;
    (globalThis as Record<string, unknown>).fetch = originalFetch;
    (globalThis as Record<string, unknown>).EventSource = originalEventSource;
    (globalThis as Record<string, unknown>).localStorage = originalLocalStorage;
    (globalThis as Record<string, unknown>).sessionStorage = originalSessionStorage;
  });

  for (const language of ['zh', 'en'] as const) {
    describe(`language=${language}`, () => {
      it.each(MATRIX_CASES)('$id', async (row) => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { createHttpCodeAgentAPI } = await import('../../../src/renderer/api/httpTransport');
        const { useAppStore } = await import('../../../src/renderer/stores/appStore');
        const { useServerConnectionStore } = await import('../../../src/renderer/stores/serverConnectionStore');
        const { getAgentSendFailureMessage } = await import('../../../src/renderer/hooks/agent/agentRuntimeFollowup');

        useAppStore.setState({ language });
        const api = createHttpCodeAgentAPI('http://localhost:8180');

        const invokeSend = () =>
          api.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, {
            content: '把下载文件夹里的三份材料整理成一页周报',
            sessionId: 'session-matrix',
          });

        const driveConnectionRecovering = async () => {
          api.on('swarm:event', () => {});
          sseInstances[0]?.onerror?.();
          await vi.advanceTimersByTimeAsync(0);
          await vi.advanceTimersByTimeAsync(WEB_SERVER_CONNECTION_MONITOR.PROBE_INTERVAL_MS);
          expect(useServerConnectionStore.getState().status).toBe('recovering');
        };

        const { error, expectedRawInWarn } = await row.run({
          invokeSend,
          driveConnectionRecovering,
        });

        if (row.id.includes('Invalid auth token')) {
          expect(window.sessionStorage.getItem('code-agent:http-auth-token-reload-attempted')).toBe('1');
          await vi.advanceTimersByTimeAsync(300);
          expect(reloadSpy).toHaveBeenCalledTimes(1);
        }

        const bubble = getAgentSendFailureMessage(error);
        process.stdout.write(`[MATRIX][${language}] ${row.id} => ${JSON.stringify(bubble)}\n`);

        expect(bubble.length).toBeGreaterThan(0);
        expect(bubble).not.toContain('云端代理请求失败');
        expect(bubble.startsWith('Error:')).toBe(false);
        expect(bubble).not.toContain(SENTINEL);
        expect(bubble).not.toContain('Load failed');
        expect(bubble).not.toContain('Invalid auth token');
        if (language === 'zh') {
          expect(CJK_RE.test(bubble)).toBe(true);
        } else {
          expect(CJK_RE.test(bubble)).toBe(false);
        }
        expect(bubble).toBe(row.expected[language]);

        if (expectedRawInWarn) {
          const allWarnText = warnSpy.mock.calls
            .map((args) =>
              args
                .map((a) => {
                  if (a instanceof Error) {
                    const extra = (a as { rawErrorBody?: unknown }).rawErrorBody ?? '';
                    return `${a.message} ${String(a.cause ?? '')} ${String(extra)}`;
                  }
                  return String(a);
                })
                .join(' '),
            )
            .join('\n');
          expect(allWarnText).toContain(expectedRawInWarn);
        }
      });
    });
  }
});
