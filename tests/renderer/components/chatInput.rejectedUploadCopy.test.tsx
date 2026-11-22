// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { MAX_FILE_SIZE } from '../../../src/renderer/components/features/chat/ChatInput/utils';
import { useFileUpload } from '../../../src/renderer/components/features/chat/ChatInput/useFileUpload';

const showToast = vi.hoisted(() => vi.fn());
const warning = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/utils/logger', () => ({ createLogger: () => ({ warn: warning, error: vi.fn() }) }));
vi.mock('../../../src/renderer/hooks/useToast', async (original) => ({
  ...await original<typeof import('../../../src/renderer/hooks/useToast')>(),
  toast: { show: (...args: unknown[]) => showToast(...args) },
}));

const getPathForFile = vi.fn<(file: File) => Promise<string>>();
const discardUploadedFiles = vi.fn<(paths: string[]) => Promise<void>>();
const extractDocxHtml = vi.fn();
const extractPdfText = vi.fn();
const extractExcelText = vi.fn();
const extractExcelJson = vi.fn();

function install(withDiscard: boolean) {
  Object.defineProperty(window, 'codeAgentAPI', { configurable: true, value: {
    getPathForFile, extractDocxHtml, extractPdfText, extractExcelText, extractExcelJson,
    ...(withDiscard ? { discardUploadedFiles } : {}),
  } });
}
async function run(file: File) {
  const { result } = renderHook(() => useFileUpload());
  let out: Awaited<ReturnType<typeof result.current.processFile>>;
  await act(async () => { out = await result.current.processFile(file); });
  return out!;
}
const big = (name: string) => new File([new Uint8Array(MAX_FILE_SIZE + 1)], name);

beforeEach(() => {
  vi.clearAllMocks();
  getPathForFile.mockImplementation(async (f) => `/data/uploads/abc-123/${f.name}`);
  discardUploadedFiles.mockResolvedValue();
  extractDocxHtml.mockResolvedValue(null);
  extractPdfText.mockResolvedValue({ text: 'pdf body', pageCount: 3 });
  extractExcelText.mockResolvedValue({ text: 'rows', sheetCount: 1, rowCount: 2 });
  extractExcelJson.mockResolvedValue({ sheets: [], sheetCount: 1 });
  install(true);
});
afterEach(() => {
  cleanup();
  delete window.codeAgentAPI;
});

describe('rejected attachments leave no uploaded copy', () => {
  it('(a) over-limit non-PDF is rejected before any upload', async () => {
    const out = await run(big('notes.txt'));
    expect(out).toBeNull();
    expect(getPathForFile).not.toHaveBeenCalled();
    expect(discardUploadedFiles).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('warning', expect.stringContaining('notes.txt'));
  });

  it('(b) docx extraction failure discards exactly the uploaded copy', async () => {
    const out = await run(new File(['x'], 'broken.docx'));
    expect(out).toBeNull();
    expect(getPathForFile).toHaveBeenCalledTimes(1);
    expect(discardUploadedFiles).toHaveBeenCalledTimes(1);
    expect(discardUploadedFiles).toHaveBeenCalledWith(['/data/uploads/abc-123/broken.docx']);
    expect(showToast).toHaveBeenCalledWith('error', expect.stringContaining('broken.docx'));
  });

  it('(b2) a rejecting extractDocxHtml rejects without an attachment', async () => {
    extractDocxHtml.mockRejectedValueOnce(new Error('docx extraction failed: end of central directory missing'));
    const out = await run(new File(['x'], 'corrupt.docx'));
    expect(out).toBeNull();
    expect(discardUploadedFiles).toHaveBeenCalledTimes(1);
    expect(discardUploadedFiles).toHaveBeenCalledWith(['/data/uploads/abc-123/corrupt.docx']);
    expect(showToast).toHaveBeenCalledWith('error', expect.stringContaining('corrupt.docx'));
  });

  it('(b3) a valid blank docx (truthy empty result) stays an accepted attachment', async () => {
    extractDocxHtml.mockResolvedValueOnce({ html: '', paragraphs: [], text: '', wordCount: 0 });
    const out = await run(new File(['x'], 'blank.docx'));
    expect(out).not.toBeNull();
    expect(out?.data).toBe('');
    expect(out?.path).toBe('/data/uploads/abc-123/blank.docx');
    expect(discardUploadedFiles).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('(b4) a rejecting extractPdfText rejects the pdf with a toast and discards the copy', async () => {
    extractPdfText.mockRejectedValueOnce(new Error('pdf extraction failed: EOF marker not found'));
    const out = await run(new File(['x'], 'broken.pdf'));
    expect(out).toBeNull();
    expect(discardUploadedFiles).toHaveBeenCalledTimes(1);
    expect(discardUploadedFiles).toHaveBeenCalledWith(['/data/uploads/abc-123/broken.pdf']);
    expect(showToast).toHaveBeenCalledWith('error', expect.stringContaining('broken.pdf'));
    expect(showToast).toHaveBeenCalledWith('error', expect.stringContaining('PDF'));
  });

  it('(b5) a falsy extractPdfText result rejects the pdf instead of attaching an empty body', async () => {
    extractPdfText.mockResolvedValueOnce(undefined);
    const out = await run(new File(['x'], 'empty.pdf'));
    expect(out).toBeNull();
    expect(discardUploadedFiles).toHaveBeenCalledWith(['/data/uploads/abc-123/empty.pdf']);
    expect(showToast).toHaveBeenCalledWith('error', expect.stringContaining('empty.pdf'));
  });

  it('(b6) a rejecting extractExcelText rejects the xlsx with a toast and discards the copy', async () => {
    extractExcelText.mockRejectedValueOnce(new Error('excel extraction failed: corrupt zip'));
    const out = await run(new File(['x'], 'broken.xlsx'));
    expect(out).toBeNull();
    expect(extractExcelJson).not.toHaveBeenCalled();
    expect(discardUploadedFiles).toHaveBeenCalledTimes(1);
    expect(discardUploadedFiles).toHaveBeenCalledWith(['/data/uploads/abc-123/broken.xlsx']);
    expect(showToast).toHaveBeenCalledWith('error', expect.stringContaining('broken.xlsx'));
  });

  it('(b7) a valid empty workbook still attaches (empty extract result is a real success)', async () => {
    extractExcelText.mockResolvedValueOnce({ text: '', sheetCount: 1, rowCount: 0 });
    const out = await run(new File(['x'], 'blank.xlsx'));
    expect(out).not.toBeNull();
    expect(out?.category).toBe('excel');
    expect(out?.data).toBe('');
    expect(discardUploadedFiles).not.toHaveBeenCalled();
  });

  it('(b8) a rejecting extractExcelJson after a good text extract stays non-blocking', async () => {
    extractExcelJson.mockRejectedValueOnce(new Error('excel extraction failed: preview parse'));
    const out = await run(new File(['x'], 'ok.xlsx'));
    expect(out).not.toBeNull();
    expect(out?.category).toBe('excel');
    expect(out?.sheetsJson).toBeUndefined();
    expect(discardUploadedFiles).not.toHaveBeenCalled();
  });

  it('(b9) scanned pdf (200 with empty text) still attaches', async () => {
    extractPdfText.mockResolvedValueOnce({ text: '', pageCount: 4 });
    const out = await run(new File(['x'], 'scan.pdf'));
    expect(out).not.toBeNull();
    expect(out?.category).toBe('pdf');
    expect(out?.pageCount).toBe(4);
    expect(discardUploadedFiles).not.toHaveBeenCalled();
  });

  it('(c) normal text file and over-limit PDF keep their uploaded copy', async () => {
    const text = await run(new File(['hello'], 'ok.txt'));
    expect(text?.path).toBe('/data/uploads/abc-123/ok.txt');
    const pdf = await run(big('large.pdf'));
    expect(pdf?.path).toBe('/data/uploads/abc-123/large.pdf');
    expect(pdf?.category).toBe('pdf');
    expect(discardUploadedFiles).not.toHaveBeenCalled();
  });

  it('(d) native bridge without discardUploadedFiles still rejects without throwing', async () => {
    install(false);
    expect(await run(big('notes.txt'))).toBeNull();
    expect(await run(new File(['x'], 'broken.docx'))).toBeNull();
    expect(discardUploadedFiles).not.toHaveBeenCalled();
  });

  it('(e) a failing discard is logged and does not change the result', async () => {
    discardUploadedFiles.mockRejectedValue(new Error('network down'));
    const out = await run(new File(['x'], 'broken.docx'));
    expect(out).toBeNull();
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('discard rejected upload failed', expect.anything()));
  });
});
