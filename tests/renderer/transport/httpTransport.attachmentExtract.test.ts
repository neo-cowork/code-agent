// @vitest-environment jsdom
// 附件正文抽取通道（pdf/excel/excel-json）的失败契约：非 2xx、fetch 异常或
// 200 但正文解不出来都必须 reject（带稳定 code），绝不回落成空对象成功——
// 旧实现把损坏/改名文件吞成 `{text:'',pageCount:0}`，混进 composer 当空附件。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: { getState: () => ({ status: 'disconnected' }) },
}));
vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({ invokeTool: vi.fn() }),
}));

import { createHttpCodeAgentAPI } from '../../../src/renderer/api/httpTransport';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { UploadFailureError } from '../../../src/renderer/utils/httpFailureMessage';

const originalFetch = globalThis.fetch;

function respond(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function rejectFetch(): void {
  globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
}

type ExtractFn = 'extractPdfText' | 'extractExcelText' | 'extractExcelJson';
const EXTRACT_CASES: ReadonlyArray<{ name: ExtractFn; endpoint: string; validBody: unknown }> = [
  { name: 'extractPdfText', endpoint: '/api/extract/pdf', validBody: { text: 'pdf body', pageCount: 3 } },
  { name: 'extractExcelText', endpoint: '/api/extract/excel', validBody: { text: 'rows', sheetCount: 1, rowCount: 2 } },
  { name: 'extractExcelJson', endpoint: '/api/extract/excel-json', validBody: { sheets: [{ name: 'S1', headers: [], rows: [], rowCount: 0 }], sheetCount: 1 } },
];

async function settleExtract(name: ExtractFn) {
  const api = createHttpCodeAgentAPI('http://localhost:8180');
  return Promise.resolve(api[name]('/tmp/broken.bin')).then(
    (value) => ({ resolved: true as const, value }),
    (error: unknown) => ({ resolved: false as const, error }),
  );
}

describe('httpTransport attachment extract functions reject on failure', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    useAppStore.setState({ language: 'zh' });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    useAppStore.setState({ language: 'zh' });
  });

  it.each(EXTRACT_CASES)('$name: HTTP 500 rejects with ATTACHMENT_EXTRACT_FAILED, never an empty success object', async ({ name, endpoint }) => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ error: 'excel extraction failed: corrupt zip' }), { status: 500 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const outcome = await settleExtract(name);
    expect(outcome.resolved).toBe(false);
    if (outcome.resolved) return;
    const error = outcome.error as { code?: unknown; message?: unknown };
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('ATTACHMENT_EXTRACT_FAILED');
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining(endpoint), expect.anything());
  });

  it.each(EXTRACT_CASES)('$name: fetch rejection rejects with ATTACHMENT_EXTRACT_FAILED', async ({ name }) => {
    rejectFetch();
    const outcome = await settleExtract(name);
    expect(outcome.resolved).toBe(false);
    if (outcome.resolved) return;
    expect((outcome.error as { code?: unknown }).code).toBe('ATTACHMENT_EXTRACT_FAILED');
  });

  it.each(EXTRACT_CASES)('$name: recoverable 401 auth error still throws UploadFailureError', async ({ name }) => {
    respond(401, { error: 'Invalid auth token' });
    const outcome = await settleExtract(name);
    expect(outcome.resolved).toBe(false);
    if (outcome.resolved) return;
    expect(outcome.error).toBeInstanceOf(UploadFailureError);
  });

  it.each(EXTRACT_CASES)('$name: HTTP 200 with a well-formed body still resolves', async ({ name, validBody }) => {
    respond(200, validBody);
    const outcome = await settleExtract(name);
    expect(outcome.resolved).toBe(true);
    if (!outcome.resolved) return;
    expect(outcome.value).toEqual(validBody);
  });

  it('extractExcelJson: HTTP 200 with a body that has no sheets rejects with ATTACHMENT_EXTRACT_FAILED', async () => {
    respond(200, { not: 'a spreadsheet payload' });
    const outcome = await settleExtract('extractExcelJson');
    expect(outcome.resolved).toBe(false);
    if (outcome.resolved) return;
    expect((outcome.error as { code?: unknown }).code).toBe('ATTACHMENT_EXTRACT_FAILED');
  });
});
