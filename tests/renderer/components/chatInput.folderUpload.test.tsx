// @vitest-environment jsdom
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { MessageAttachment } from '../../../src/shared/contract';
import { buildMultimodalContent } from '../../../src/host/agent/messageHandling/converter';

const ipc = vi.hoisted(() => ({ getPathForFile: vi.fn() }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: ipc }));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { show: vi.fn() } }));
vi.mock('../../../src/renderer/components/features/chat/ChatInput/attachmentSummaries', () => ({
  buildArchiveManifest: vi.fn(), buildPresentationSummary: vi.fn(),
}));
import { useFileUpload } from '../../../src/renderer/components/features/chat/ChatInput/useFileUpload';

function directory(files: File[], name = 'contract-bundle'): FileSystemDirectoryEntry {
  return {
    name, isFile: false, isDirectory: true,
    createReader: () => {
      let read = false;
      return { readEntries: (resolve: (entries: unknown[]) => void) => {
        resolve(read ? [] : files.map((file) => ({
          name: file.name, isFile: true, isDirectory: false,
          file: (accept: (value: File) => void) => accept(file),
        })));
        read = true;
      } };
    },
  } as unknown as FileSystemDirectoryEntry;
}

function fixtureFiles(): File[] {
  return [
    ['scan-contract.pdf', 'application/pdf'],
    ['budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['logo.png', 'image/png'], ['notes.txt', 'text/plain'],
  ].map(([name, type]) => new File([
    new Uint8Array(readFileSync(`tests/fixtures/folder-attachment/${name}`)),
  ], name, { type }));
}

async function processFolder(files: File[]) {
  const { result, unmount } = renderHook(() => useFileUpload());
  let attachment: MessageAttachment | null = null;
  await act(async () => { attachment = await result.current.processFolderEntry(directory(files), 'contract-bundle'); });
  unmount();
  return attachment! as MessageAttachment;
}

describe('folder upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.getPathForFile.mockImplementation(async (file: File) => `/tmp/uploads/${file.name}`);
  });

  it('real PDF fixture stores no binary text and carries its own readable path', async () => {
    const attachment = await processFolder(fixtureFiles());
    const modelText = buildMultimodalContent('what is this contract about?', [attachment]);
    if (process.env.FOLDER_CAPTURE) {
      writeFileSync(`${process.env.FOLDER_CAPTURE}.json`, JSON.stringify(attachment, null, 2));
      writeFileSync(`${process.env.FOLDER_CAPTURE}.txt`, modelText.map((part) => part.text ?? '').join('\n'));
    }
    expect(attachment.files).toHaveLength(4);
    expect(attachment.files!.every((file) => !file.content?.includes('%PDF'))).toBe(true);
    expect(attachment.files![0].absolutePath).toBe('/tmp/uploads/scan-contract.pdf');
    for (const [index, type] of ['pdf', 'excel', 'image'].entries()) {
      expect(attachment.files![index]).toEqual({
        path: `contract-bundle/${fixtureFiles()[index].name}`,
        size: fixtureFiles()[index].size, type, binary: true,
        absolutePath: `/tmp/uploads/${fixtureFiles()[index].name}`,
      });
    }
    expect(attachment.files![3].content).toBe('附件测试说明：请以合同正文为准。\n');
    expect(attachment.path).toBeUndefined();
    expect(attachment.data).toContain('无法确定文件夹的可读路径');
    expect(ipc.getPathForFile).toHaveBeenCalledTimes(4);
  });

  it('decodes only text/code/data/html, including extension-only binary files', async () => {
    const read = vi.spyOn(FileReader.prototype, 'readAsText');
    const names = ['a.pdf', 'a.xlsx', 'a.pptx', 'a.zip', 'a.mp3', 'a.mp4', 'a.png'];
    const attachment = await processFolder([
      ...names.map((name) => new File(['binary'], name)),
      new File(['const value = 42;'], 'a.ts'),
      new File(['{"value":42}'], 'a.json'),
      new File(['<p>text</p>'], 'a.html'),
    ]);
    expect(read.mock.calls.map(([file]) => (file as File).name)).toEqual(['a.ts', 'a.json', 'a.html']);
    expect(attachment.files!.slice(0, 7).every((file) => file.binary && file.content === undefined)).toBe(true);
    expect(attachment.files!.slice(7).map((file) => file.content)).toEqual(['const value = 42;', '{"value":42}', '<p>text</p>']);
    read.mockRestore();
  });

  it('caps requests at 10 (half the shared 20/min server bucket), prioritizes binaries, and keeps the 50-file limit', async () => {
    const attachment = await processFolder([
      ...Array.from({ length: 25 }, (_, n) => new File(['text'], `note${n}.txt`)),
      ...Array.from({ length: 30 }, (_, n) => new File(['%PDF'], `contract${n}.pdf`)),
    ]);
    expect(attachment.files).toHaveLength(50);
    expect(ipc.getPathForFile).toHaveBeenCalledTimes(10);
    expect(ipc.getPathForFile.mock.calls.every(([file]) => (file as File).name.endsWith('.pdf'))).toBe(true);
    expect(attachment.files!.filter((file) => file.absolutePath)).toHaveLength(10);
    expect(attachment.files!.slice(0, 25).every((file) => file.content === 'text')).toBe(true);
    expect(attachment.data).toContain('50');
  });

  it('retains metadata when upload fails and rejects relative tool paths', async () => {
    ipc.getPathForFile.mockRejectedValueOnce(new Error('Upload failed: 429'))
      .mockResolvedValueOnce('relative/budget.xlsx').mockResolvedValueOnce('');
    const attachment = await processFolder(fixtureFiles());
    expect(attachment.files).toHaveLength(4);
    expect(attachment.files!.slice(0, 3).every((file) => file.absolutePath === undefined)).toBe(true);
    expect(attachment.path).toBeUndefined();
    expect(attachment.data).toContain('无法确定文件夹的可读路径');
  });

  it('records a common native root only when every file is actually there', async () => {
    ipc.getPathForFile.mockImplementation(async (file: File) => `/tmp/native/contract-bundle/${file.name}`);
    const attachment = await processFolder(fixtureFiles());
    expect(attachment.path).toBe('/tmp/native/contract-bundle');
    expect(attachment.data).not.toContain('无法确定');
  });

  it('keeps text metadata when FileReader fails instead of losing the file', async () => {
    const read = vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
      this.dispatchEvent(new ProgressEvent('error'));
    });
    ipc.getPathForFile.mockResolvedValue(undefined);
    const attachment = await processFolder([new File(['text'], 'notes.txt')]);
    expect(attachment.files).toEqual([{ path: 'contract-bundle/notes.txt', size: 4 }]);
    read.mockRestore();
  });
});
