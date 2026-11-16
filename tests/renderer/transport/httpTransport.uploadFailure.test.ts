// @vitest-environment jsdom
// 库上传 / 附件上传 getPathForFile 的非 2xx：用户只看到人话 + 等待时间，不见状态码。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: { getState: () => ({ status: 'disconnected' }) },
}));
vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({ invokeTool: vi.fn() }),
}));

import { createHttpCodeAgentAPI } from '../../../src/renderer/api/httpTransport';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const originalFetch = globalThis.fetch;

function respond(status: number, body: unknown, headers: Record<string, string> = {}): void {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
}

async function upload(): Promise<Error> {
  const api = createHttpCodeAgentAPI('http://localhost:8180');
  const file = new File(['# notes'], 'weekly.md', { type: 'text/markdown' });
  return api.getPathForFile(file).then(
    () => { throw new Error('expected rejection'); },
    (e: Error) => e,
  );
}

describe('httpTransport getPathForFile non-2xx', () => {
  beforeEach(() => { window.sessionStorage.clear(); });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    useAppStore.setState({ language: 'zh' });
  });

  it('429 + Retry-After: 20 → zh/en copy with the wait time and no status code', async () => {
    respond(429, { error: 'Too many requests. Please try again later.' }, { 'Retry-After': '20' });
    useAppStore.setState({ language: 'zh' });
    const zh = await upload();
    expect(zh.message).toContain('20 秒');
    expect(zh.message).not.toContain('Upload failed');
    expect(zh.message).not.toContain('429');

    useAppStore.setState({ language: 'en' });
    const en = await upload();
    expect(en.message).toContain('20 seconds');
    expect(en.message).not.toContain('Upload failed');
    expect(en.message).not.toContain('429');
  });

  it('429 with only the body field (header unreadable cross-origin) still shows the wait', async () => {
    respond(429, { error: 'Too many requests.', retryAfterSeconds: 7 });
    expect((await upload()).message).toContain('7 秒');
  });

  it('429 with neither header nor body field → "a moment" copy', async () => {
    respond(429, { error: 'Too many requests.' });
    const zh = await upload();
    expect(zh.message).toContain('稍等片刻');
    expect(zh.message).not.toMatch(/429|Upload failed/);
    useAppStore.setState({ language: 'en' });
    const en = await upload();
    expect(en.message).toContain('a moment');
    expect(en.message).not.toMatch(/429|Upload failed/);
  });

  it('413 and 500 get their own plain copy', async () => {
    respond(413, { error: 'File too large' });
    const tooLarge = await upload();
    expect(tooLarge.message).toContain('文件太大');
    respond(500, { error: 'boom' });
    const generic = await upload();
    expect(generic.message).toContain('没能上传');
    for (const e of [tooLarge, generic]) expect(e.message).not.toMatch(/413|500|Upload failed|boom/);
  });
});
