// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpCodeAgentAPI } from '../../../src/renderer/api/httpTransport';
import { MAX_UPLOAD_DISCARD_PATHS } from '../../../src/shared/constants/uploadDiscard';

const originalWindow = globalThis.window;
afterEach(() => { vi.unstubAllGlobals(); globalThis.window = originalWindow; });
describe('HTTP bridge temporary upload discard', () => {
  function bridge() {
    vi.stubGlobal('window', { __CODE_AGENT_TOKEN__: 'test-token' });
    return createHttpCodeAgentAPI('http://localhost:8180');
  }
  it('posts exact rejected paths to the authenticated route, outside the temp bucket', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const api = bridge();
    await api.discardUploadedFiles!(['/tmp/uploads/rejected.txt']);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('http://localhost:8180/api/upload/discard', {
      method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/tmp/uploads/rejected.txt'] }),
    });
  });
  it('deduplicates paths and splits requests at the server bound', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const paths = Array.from({ length: MAX_UPLOAD_DISCARD_PATHS + 1 }, (_, i) => `/tmp/uploads/${i}`);
    await bridge().discardUploadedFiles!([...paths, paths[0]]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0][1].body).paths).toEqual(paths.slice(0, MAX_UPLOAD_DISCARD_PATHS));
    expect(JSON.parse(fetch.mock.calls[1][1].body).paths).toEqual(paths.slice(MAX_UPLOAD_DISCARD_PATHS));
  });
  it('does not request for an empty list and propagates server failure for warning-only handling', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    const api = bridge();
    await api.discardUploadedFiles!([]);
    expect(fetch).not.toHaveBeenCalled();
    await expect(api.discardUploadedFiles!(['/tmp/uploads/rejected.txt'])).rejects.toThrow('Upload discard failed: 500');
  });
});
