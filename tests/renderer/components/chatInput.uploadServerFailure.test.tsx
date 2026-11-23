// @vitest-environment jsdom
// 附件上传到服务端失败：PDF/Word/Excel 没有本地兜底 → 一句人话 toast + 不产出附件；其余类别静默走本地读取。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const showToast = vi.hoisted(() => vi.fn());
const ipc = vi.hoisted(() => ({
  getPathForFile: vi.fn(),
  extractDocxHtml: vi.fn(),
  extractExcelText: vi.fn(),
  extractExcelJson: vi.fn(),
  extractPdfText: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { show: (...args: unknown[]) => showToast(...args) },
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: ipc }));
vi.mock('../../../src/renderer/components/features/chat/ChatInput/attachmentSummaries', () => ({
  buildArchiveManifest: vi.fn(async () => ({})),
  buildPresentationSummary: vi.fn(async () => ({})),
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { useFileUpload } from '../../../src/renderer/components/features/chat/ChatInput/useFileUpload';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { UploadFailureError } from '../../../src/renderer/utils/httpFailureMessage';
import { languages } from '../../../src/renderer/i18n';

async function processFile(file: File) {
  const { result } = renderHook(() => useFileUpload());
  let attachment: Awaited<ReturnType<typeof result.current.processFile>>;
  await act(async () => {
    attachment = await result.current.processFile(file);
  });
  return attachment!;
}

const REASON = { zh: '上传太频繁了，请约 45 秒后再试。', en: 'Too many uploads in a short time. Try again in about 45 seconds.' };

describe.each(['zh', 'en'] as const)('processFile when the server upload fails (%s)', (lang) => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ language: lang });
    ipc.getPathForFile.mockRejectedValue(new UploadFailureError(REASON[lang]));
  });

  it.each(['contract.pdf', 'contract.docx', 'budget.xlsx'])('%s → one reason toast, null, no unsupported toast', async (name) => {
    expect(await processFile(new File(['x'], name))).toBeNull();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('error', lang === 'zh' ? `${name}：${REASON.zh}` : `${name}: ${REASON.en}`);
    const unsupported = languages[lang].chatInput.uploadUnsupported.replace('{name}', name);
    expect(showToast).not.toHaveBeenCalledWith(expect.anything(), unsupported);
  });

  it.each([
    ['notes.md', 'text'],
    ['photo.png', 'image'],
    ['slides.pptx', 'presentation'],
    ['bundle.zip', 'archive'],
    ['voice.mp3', 'audio'],
  ])('%s → no toast, attachment still produced', async (name, category) => {
    const attachment = await processFile(new File(['hello'], name, name.endsWith('.png') ? { type: 'image/png' } : {}));
    expect(showToast).not.toHaveBeenCalled();
    expect(attachment).not.toBeNull();
    expect(attachment!.name).toBe(name);
    expect(attachment!.category).toBe(category);
  });

  it('a non-UploadFailureError never leaks its raw message', async () => {
    ipc.getPathForFile.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await processFile(new File(['x'], 'contract.docx'))).toBeNull();
    const text = String(showToast.mock.calls[0][1]);
    expect(text).not.toContain('Failed to fetch');
    expect(text).toContain(lang === 'zh' ? '没能上传这个文件' : 'Could not upload this file');
    expect(text.startsWith(lang === 'zh' ? 'contract.docx：' : 'contract.docx: ')).toBe(true);
  });
});
