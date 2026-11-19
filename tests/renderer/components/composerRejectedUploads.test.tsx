// @vitest-environment jsdom
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, fireEvent } from '@testing-library/react';

const showToast = vi.hoisted(() => vi.fn());
const ipc = vi.hoisted(() => ({ getPathForFile: vi.fn() }));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { show: (...args: unknown[]) => showToast(...args) },
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: ipc }));
vi.mock('../../../src/renderer/components/features/chat/ChatInput/utils', () => ({
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  MAX_FOLDER_FILES: 100,
  generateAttachmentId: () => 'attachment-1',
  extractPdfText: vi.fn(async () => ({ text: 'pdf', pageCount: 1 })),
  readDirectoryEntry: vi.fn(),
  getFileCategory: (file: File) => ({
    category: file.name.endsWith('.pdf') ? 'pdf' : file.name.endsWith('.txt') ? 'code' : 'video',
    language: undefined,
  }),
}));
vi.mock('../../../src/renderer/components/features/chat/ChatInput/attachmentSummaries', () => ({
  buildArchiveManifest: vi.fn(),
  buildPresentationSummary: vi.fn(),
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { useFileUpload } from '../../../src/renderer/components/features/chat/ChatInput/useFileUpload';
import { ComposerRejectedUploadsNotice } from '../../../src/renderer/components/features/chat/ChatInput/ComposerRejectedUploadsNotice';
import { useComposerRejectedUploadsStore } from '../../../src/renderer/stores/composerRejectedUploadsStore';
import { COMPOSER_SLOT_LAYER } from '../../../src/renderer/stores/composerNoticeStore';

const MB = 1024 * 1024;
function bigFile(name: string, size: number): File {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
}
const items = () => useComposerRejectedUploadsStore.getState().items;

beforeEach(() => {
  vi.clearAllMocks();
  useComposerRejectedUploadsStore.setState({ items: [] });
  ipc.getPathForFile.mockImplementation(async (f: File) => `/tmp/${f.name}`);
});
afterEach(() => useComposerRejectedUploadsStore.setState({ items: [] }));

describe('rejected uploads store', () => {
  it('add / dismiss / clear', () => {
    const s = useComposerRejectedUploadsStore.getState();
    s.add({ name: 'a', size: 1 });
    s.add({ name: 'b', size: 2 });
    expect(items().map((i) => i.name)).toEqual(['a', 'b']);
    s.dismiss(items()[0].id);
    expect(items().map((i) => i.name)).toEqual(['b']);
    s.clear();
    expect(items()).toEqual([]);
  });
  it('is registered in the composer slot at layer 3', () => {
    expect(COMPOSER_SLOT_LAYER['rejected-uploads']).toBe(3);
  });
});

describe('ComposerRejectedUploadsNotice', () => {
  it('renders nothing when empty', () => {
    render(<ComposerRejectedUploadsNotice />);
    expect(screen.queryByTestId('composer-rejected-uploads')).toBeNull();
  });
  it('renders one row per file, caps at 3 with an overflow line, and dismisses', () => {
    render(<ComposerRejectedUploadsNotice />);
    act(() => {
      const s = useComposerRejectedUploadsStore.getState();
      s.add({ name: 'demo.mp4', size: 25 * MB });
      s.add({ name: 'b.mp4', size: 11 * MB });
      s.add({ name: 'c.mp4', size: 12 * MB });
    });
    expect(screen.getAllByTestId('composer-rejected-upload-row')).toHaveLength(3);
    expect(screen.getByTestId('composer-rejected-uploads').textContent).toContain('demo.mp4');
    expect(screen.getByTestId('composer-rejected-uploads').textContent).toContain('25.0MB');
    expect(screen.queryByTestId('composer-rejected-uploads-more')).toBeNull();
    act(() => {
      const s = useComposerRejectedUploadsStore.getState();
      s.add({ name: 'd.mp4', size: 13 * MB });
      s.add({ name: 'e.mp4', size: 14 * MB });
    });
    expect(screen.getAllByTestId('composer-rejected-upload-row')).toHaveLength(3);
    expect(screen.getByTestId('composer-rejected-uploads-more')).toBeTruthy();
    fireEvent.click(screen.getAllByTestId('composer-rejected-upload-dismiss')[0]);
    expect(items()).toHaveLength(4);
    expect(screen.getByTestId('composer-rejected-uploads').textContent).not.toContain('demo.mp4');
  });

  it('dismiss X inside the composer <form> only removes that row and does not submit', () => {
    // X 挂在 composer <form> 里；无 type 的 button 默认是 submit，点 X 会顺带发送草稿。
    // 复刻 attachmentMergeToast 的表单包裹 + submit 探针写法。
    const submit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form data-testid="composer-form" onSubmit={submit}>
        <ComposerRejectedUploadsNotice />
        <textarea data-testid="composer-textarea" defaultValue="草稿正文" />
      </form>
    );
    act(() => {
      const s = useComposerRejectedUploadsStore.getState();
      s.add({ name: 'demo.mp4', size: 25 * MB });
      s.add({ name: 'other.mp4', size: 11 * MB });
    });
    fireEvent.click(screen.getAllByTestId('composer-rejected-upload-dismiss')[0]);
    expect(submit).not.toHaveBeenCalled(); // X 不是发送键
    expect(screen.getByTestId('composer-rejected-uploads').textContent).not.toContain('demo.mp4');
    expect(screen.getByTestId('composer-rejected-uploads').textContent).toContain('other.mp4');
    expect(screen.getAllByTestId('composer-rejected-upload-row')).toHaveLength(1);
    expect((screen.getByTestId('composer-textarea') as HTMLTextAreaElement).value).toBe('草稿正文');
  });
});

describe('useFileUpload oversize branch', () => {
  async function run(file: File) {
    const { result } = renderHook(() => useFileUpload());
    let out: Awaited<ReturnType<typeof result.current.processFile>>;
    await act(async () => { out = await result.current.processFile(file); });
    return out!;
  }
  it('oversize non-PDF adds a persistent entry, still toasts and returns null', async () => {
    const out = await run(bigFile('demo.mp4', 25 * MB));
    expect(out).toBeNull();
    expect(showToast).toHaveBeenCalledWith('warning', expect.stringContaining('demo.mp4'));
    expect(items()).toMatchObject([{ name: 'demo.mp4', size: 25 * MB }]);
  });
  it('oversize PDF (path-only) and normal files add nothing', async () => {
    const pdf = await run(bigFile('big.pdf', 25 * MB));
    expect(pdf?.category).toBe('pdf');
    await run(bigFile('small.txt', 100));
    expect(items()).toEqual([]);
  });
});
