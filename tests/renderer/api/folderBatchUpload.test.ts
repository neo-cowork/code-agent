import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFolderBatchUpload } from '../../../src/renderer/api/folderBatchUpload';

afterEach(() => vi.unstubAllGlobals());

describe('folder batch HTTP capability', () => {
  const files = [{ file: new File(['contract'], 'terms.pdf'), relativePath: 'contracts/nested/terms.pdf' }];
  it('pairs each file part with its relativePath in one authenticated request', async () => {
    const result = { root: '/tmp/batch', files: [{ relativePath: files[0].relativePath, path: '/tmp/batch/contracts/nested/terms.pdf' }] };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetch);
    expect(await createFolderBatchUpload('http://localhost:8180', () => ({ Authorization: 'Bearer test-token' }))(files)).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('http://localhost:8180/api/upload/temp/batch');
    expect(options.headers).toEqual({ Authorization: 'Bearer test-token' });
    expect((options.body as FormData).get('file0')).toEqual(files[0].file);
    expect((options.body as FormData).get('relativePath0')).toBe(files[0].relativePath);
  });
  it.each([404, 429])('propagates HTTP %i for the hook fallback', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
    await expect(createFolderBatchUpload('', () => ({}))(files)).rejects.toThrow(`Batch upload failed: ${status}`);
  });
  it('rejects missing paths or a mismatched file list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ root: '/tmp/batch', files: [] }))));
    await expect(createFolderBatchUpload('', () => ({}))(files)).rejects.toThrow('Invalid batch upload response');
  });
});
