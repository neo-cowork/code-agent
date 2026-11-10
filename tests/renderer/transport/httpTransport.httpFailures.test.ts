import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpCodeAgentAPI, createHttpDomainAPI } from '../../../src/renderer/api/httpTransport';
import { takeTransportFailure } from '../../../src/renderer/api/transportFailures';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({ useLocalBridgeStore: { getState: () => ({ status: 'disconnected' }) } }));

const messages = {
  zh: 'Neo 暂时无法完成请求，请稍后重试。',
  en: 'Neo could not complete the request; please try again in a moment.',
};
const bodies = [
  '<html><pre>INTERNAL_PRIVATE_STACK /private/server.ts</pre></html>',
  JSON.stringify({ error: { message: 'INTERNAL_PRIVATE_STACK /private/server.ts', code: 'INTERNAL_SERVER_ERROR' } }),
  '',
];

beforeEach(() => {
  vi.stubGlobal('window', { __CODE_AGENT_TOKEN__: 'local-token' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ language: 'zh' });
});

describe('public HTTP send failure copy', () => {
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
