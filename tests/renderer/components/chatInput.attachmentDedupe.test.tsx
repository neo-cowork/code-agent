// @vitest-environment jsdom

import React, { createRef, useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '../../../src/shared/contract';
import { UI } from '../../../src/shared/constants';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const toastSpy = vi.hoisted(() => ({
  show: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));
const i18nState = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
}));
const readWorkspaceFile = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: toastSpy }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: i18nState.language === 'en' ? en : zh, language: i18nState.language }),
}));
vi.mock('../../../src/renderer/components/design/designFiles', () => ({ readWorkspaceFile }));
vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: vi.fn().mockResolvedValue([]),
  getSessionPin: vi.fn().mockResolvedValue({ itemIds: [] }),
  setSessionPin: vi.fn(),
}));
vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjects: vi.fn().mockResolvedValue([]),
  getProjectArtifacts: vi.fn().mockResolvedValue([]),
}));

import { ChatInput, type ChatInputHandle } from '../../../src/renderer/components/features/chat/ChatInput';
import { useChatInputComposerActions } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputComposerActions';
import { useDragAndDrop } from '../../../src/renderer/components/features/chat/ChatInput/useDragAndDrop';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import ipcService from '../../../src/renderer/services/ipcService';

let attachmentId = 0;

function readFile(file: File, dataUrl: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    if (dataUrl) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

async function processFile(file: File): Promise<MessageAttachment> {
  const isImage = file.type.startsWith('image/');
  return {
    id: `attachment-${++attachmentId}`,
    type: isImage ? 'image' : 'file',
    category: isImage ? 'image' : 'data',
    name: file.name,
    size: file.size,
    mimeType: file.type,
    data: await readFile(file, isImage),
    path: `/tmp/web-upload-${attachmentId}/${file.name}`,
  };
}

function useComposerActionsHarness() {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const actions = useChatInputComposerActions({
    processFile,
    inputAreaRef: { current: null },
    setIsUploading: vi.fn(),
    setAttachments,
    setValue: vi.fn(),
    setVoiceInputContext: vi.fn(),
  });
  return { attachments, ...actions };
}

function useDropHarness() {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const actions = useDragAndDrop({
    processFile,
    processFolderEntry: vi.fn(),
    setAttachments,
    setIsUploading: vi.fn(),
  });
  return { attachments, ...actions };
}

function asFileList(files: File[]): FileList {
  return files as unknown as FileList;
}

function dropEvent(file: File): React.DragEvent {
  return dropFilesEvent([file]);
}

function dropFilesEvent(files: File[]): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: { files, items: [] },
  } as unknown as React.DragEvent;
}

function uniqueFiles(count: number, startIndex = 1): File[] {
  return Array.from({ length: count }, (_, offset) => {
    const num = String(startIndex + offset).padStart(2, '0');
    return new File([`contract body ${num}`], `contract-${num}.txt`, { type: 'text/plain' });
  });
}

function uniqueAttachment(index: number): MessageAttachment {
  const num = String(index).padStart(2, '0');
  return {
    id: `att-${num}`,
    type: 'file',
    category: 'text',
    name: `contract-${num}.txt`,
    size: 16,
    mimeType: 'text/plain',
    data: `contract body ${num}`,
  };
}

function attachment(id: string): MessageAttachment {
  return {
    id,
    type: 'file',
    category: 'data',
    name: 'sales.csv',
    size: 8,
    mimeType: 'text/csv',
    data: 'region,1',
  };
}

function resetCapabilityStore(): void {
  useBundledCapabilityStore.setState({
    installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
    states: [],
    loaded: true,
    error: null,
  });
}

function setCaret(node: Node): void {
  const range = document.createRange();
  range.setStart(node, node.textContent?.length ?? 0);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function appendAtTrigger(): void {
  const editor = screen.getByTestId('chat-composer-textarea');
  const text = document.createTextNode('@');
  editor.appendChild(text);
  setCaret(text);
  fireEvent.input(editor);
}

describe('ChatInput attachment dedupe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    attachmentId = 0;
    i18nState.language = 'zh';
    resetCapabilityStore();
    Element.prototype.scrollIntoView = vi.fn();
    readWorkspaceFile.mockResolvedValue('region,sales\nNorth,10');
    vi.spyOn(ipcService, 'invokeDomain').mockImplementation((domain, action) => {
      if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') return Promise.resolve([]);
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return Promise.resolve({} as never);
      return Promise.reject(new Error(`Unexpected IPC: ${domain}.${action}`));
    });
    (window as { domainAPI?: unknown }).domainAPI = {
      invoke: vi.fn().mockImplementation((domain: string, action: string) => {
        if (domain === IPC_DOMAINS.WORKSPACE && action === 'listFiles') {
          return Promise.resolve({
            success: true,
            data: [{ name: 'sales.csv', path: 'sales.csv', isDirectory: false }],
          });
        }
        return Promise.resolve({ success: true, data: [] });
      }),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as { domainAPI?: unknown }).domainAPI;
    resetCapabilityStore();
  });

  it('select: selecting the same sales.csv twice keeps one attachment', async () => {
    const { result } = renderHook(() => useComposerActionsHarness());
    const file = new File(['region,sales\nNorth,10'], 'sales.csv', { type: 'text/csv' });

    await act(async () => { await result.current.handleFileSelect(asFileList([file])); });
    await act(async () => { await result.current.handleFileSelect(asFileList([file])); });

    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]?.data).toBe('region,sales\nNorth,10');
    expect(toastSpy.show).toHaveBeenCalledTimes(1);
    expect(toastSpy.show).toHaveBeenCalledWith('warning', 'sales.csv 已添加，无需重复添加');
  });

  it('select: same-name files with different content remain two attachments', async () => {
    const { result } = renderHook(() => useComposerActionsHarness());
    const first = new File(['region,sales\nNorth,10'], 'sales.csv', { type: 'text/csv' });
    const second = new File(['region,sales\nSouth,20'], 'sales.csv', { type: 'text/csv' });

    await act(async () => { await result.current.handleFileSelect(asFileList([first, second])); });

    expect(result.current.attachments).toHaveLength(2);
    expect(toastSpy.show).not.toHaveBeenCalled();
  });

  it('select: one batch with multiple duplicates shows exactly one warning', async () => {
    const { result } = renderHook(() => useComposerActionsHarness());
    const file = new File(['region,sales\nNorth,10'], 'sales.csv', { type: 'text/csv' });

    await act(async () => { await result.current.handleFileSelect(asFileList([file])); });
    await act(async () => { await result.current.handleFileSelect(asFileList([file, file])); });

    expect(result.current.attachments).toHaveLength(1);
    expect(toastSpy.show).toHaveBeenCalledTimes(1);
  });

  it('select: duplicates do not consume the attachment cap', async () => {
    const { result } = renderHook(() => useComposerActionsHarness());
    const files = Array.from({ length: 5 }, (_, index) => (
      new File([`value,${index}`], `file-${index}.csv`, { type: 'text/csv' })
    ));
    const sixth = new File(['value,5'], 'file-5.csv', { type: 'text/csv' });

    await act(async () => { await result.current.handleFileSelect(asFileList(files.slice(0, 4))); });
    await act(async () => { await result.current.handleFileSelect(asFileList([files[0]!, sixth])); });

    expect(result.current.attachments).toHaveLength(5);
    expect(result.current.attachments.map((item) => item.name)).toContain('file-5.csv');
  });

  it('paste: pasting the same image twice keeps one attachment and warns once', async () => {
    const { result } = renderHook(() => useComposerActionsHarness());
    const image = new File(['same-image-bytes'], 'image.png', { type: 'image/png' });

    await act(async () => { await result.current.handleImagePaste(image); });
    await act(async () => { await result.current.handleImagePaste(image); });

    expect(result.current.attachments).toHaveLength(1);
    expect(toastSpy.show).toHaveBeenCalledTimes(1);
    expect(toastSpy.show).toHaveBeenCalledWith('warning', 'image.png 已添加，无需重复添加');
  });

  it('paste: same-name images with different bytes remain two attachments', async () => {
    const { result } = renderHook(() => useComposerActionsHarness());
    const first = new File(['first-image'], 'image.png', { type: 'image/png' });
    const second = new File(['other-image'], 'image.png', { type: 'image/png' });

    await act(async () => { await result.current.handleImagePaste(first); });
    await act(async () => { await result.current.handleImagePaste(second); });

    expect(result.current.attachments).toHaveLength(2);
    expect(toastSpy.show).not.toHaveBeenCalled();
  });

  it('drop: dropping the same file twice keeps one attachment and warns once', async () => {
    const { result } = renderHook(() => useDropHarness());
    const file = new File(['region,sales\nNorth,10'], 'sales.csv', { type: 'text/csv' });

    await act(async () => { await result.current.handleDrop(dropEvent(file)); });
    await act(async () => { await result.current.handleDrop(dropEvent(file)); });

    expect(result.current.attachments).toHaveLength(1);
    expect(toastSpy.show).toHaveBeenCalledTimes(1);
  });

  it('imperative addAttachments: adding the same file twice keeps one chip and warns once', async () => {
    const ref = createRef<ChatInputHandle>();
    render(<ChatInput ref={ref} onSend={vi.fn()} />);

    act(() => { ref.current!.addAttachments([attachment('first')]); });
    act(() => { ref.current!.addAttachments([attachment('second')]); });

    await waitFor(() => expect(screen.getAllByRole('group', { name: 'sales.csv' })).toHaveLength(1));
    expect(toastSpy.show).toHaveBeenCalledTimes(1);
    expect(toastSpy.show).toHaveBeenCalledWith('warning', 'sales.csv 已添加，无需重复添加');
  });

  it('@-mention: duplicate selection leaves one attached chip and no dangling mount', async () => {
    render(<ChatInput onSend={vi.fn()} />);

    appendAtTrigger();
    fireEvent.click(await screen.findByRole('button', { name: 'sales.csv' }));
    await waitFor(() => expect(screen.getAllByRole('group', { name: 'sales.csv' })).toHaveLength(1));

    appendAtTrigger();
    fireEvent.click(await screen.findByRole('button', { name: 'sales.csv' }));

    await waitFor(() => expect(toastSpy.show).toHaveBeenCalledTimes(1));
    expect(screen.getAllByRole('group', { name: 'sales.csv' })).toHaveLength(1);
    const editor = screen.getByTestId('chat-composer-textarea');
    expect(editor.querySelectorAll('[data-composer-chip-key^="file:"]')).toHaveLength(1);
    expect(toastSpy.show).toHaveBeenCalledWith('warning', 'sales.csv 已添加，无需重复添加');
  });

  it('over-cap picker: keeps MAX_ATTACHMENTS chips and shows kept/dropped warning toast', async () => {
    const cap = UI.MAX_ATTACHMENTS;
    const total = cap * 3;
    const dropped = total - cap;
    const { result } = renderHook(() => useComposerActionsHarness());

    await act(async () => {
      await result.current.handleFileSelect(asFileList(uniqueFiles(total)));
    });

    expect(result.current.attachments).toHaveLength(cap);
    expect(result.current.attachments[0]?.name).toBe('contract-01.txt');
    expect(result.current.attachments[cap - 1]?.name).toBe(`contract-${String(cap).padStart(2, '0')}.txt`);
    expect(toastSpy.show).toHaveBeenCalledTimes(1);
    expect(toastSpy.show).toHaveBeenCalledWith(
      'warning',
      `已添加 ${cap} 个，其余 ${dropped} 个未添加（每条消息最多 ${cap} 个）。请先发送这一批，再继续添加。`,
    );
  });

  it('at-or-under cap: selecting up to MAX_ATTACHMENTS files shows no overflow toast', async () => {
    const cap = UI.MAX_ATTACHMENTS;
    const firstBatchCount = cap - 4;
    const { result } = renderHook(() => useComposerActionsHarness());

    await act(async () => {
      await result.current.handleFileSelect(asFileList(uniqueFiles(firstBatchCount, 1)));
    });
    expect(result.current.attachments).toHaveLength(firstBatchCount);
    expect(toastSpy.show).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleFileSelect(asFileList(uniqueFiles(cap - firstBatchCount, firstBatchCount + 1)));
    });
    expect(result.current.attachments).toHaveLength(cap);
    expect(toastSpy.show).not.toHaveBeenCalled();
  });

  it('duplicates-only at cap: shows duplicate toast only and no overflow toast', async () => {
    const cap = UI.MAX_ATTACHMENTS;
    const files = uniqueFiles(cap);
    const { result } = renderHook(() => useComposerActionsHarness());

    await act(async () => {
      await result.current.handleFileSelect(asFileList(files));
    });
    expect(toastSpy.show).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleFileSelect(asFileList([files[0]!, files[1]!]));
    });

    expect(result.current.attachments).toHaveLength(cap);
    expect(toastSpy.show).toHaveBeenCalledTimes(1);
    expect(toastSpy.show).toHaveBeenCalledWith('warning', 'contract-01.txt 已添加，无需重复添加');
  });

  it('existing chips + incoming mix: counts only unique files dropped by the cap', async () => {
    const cap = UI.MAX_ATTACHMENTS;
    const initialCount = cap - 2;
    const initialFiles = uniqueFiles(initialCount, 1);
    const newBatch = [initialFiles[0]!, ...uniqueFiles(5, initialCount + 1)];
    const { result } = renderHook(() => useComposerActionsHarness());

    await act(async () => {
      await result.current.handleFileSelect(asFileList(initialFiles));
    });
    expect(result.current.attachments).toHaveLength(initialCount);
    expect(toastSpy.show).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleFileSelect(asFileList(newBatch));
    });

    expect(result.current.attachments).toHaveLength(cap);
    expect(toastSpy.show).toHaveBeenCalledTimes(2);
    expect(toastSpy.show).toHaveBeenNthCalledWith(1, 'warning', 'contract-01.txt 已添加，无需重复添加');
    expect(toastSpy.show).toHaveBeenNthCalledWith(
      2,
      'warning',
      `已添加 2 个，其余 3 个未添加（每条消息最多 ${cap} 个）。请先发送这一批，再继续添加。`,
    );
  });

  it.each([
    {
      language: 'zh' as const,
      expectedZeroAdded: (cap: number) =>
        `已添加 0 个，其余 1 个未添加（每条消息最多 ${cap} 个）。请先发送这一批，再继续添加。`,
    },
    {
      language: 'en' as const,
      expectedZeroAdded: (cap: number) =>
        `Added 0; 1 more were not added (limit ${cap} per message). Send this batch, then add the rest.`,
    },
  ])('picker, paste, drop and addAttachments use identical $language overflow copy', async ({ language, expectedZeroAdded }) => {
    i18nState.language = language;
    const cap = UI.MAX_ATTACHMENTS;
    const expectedMessage = expectedZeroAdded(cap);

    // 1. Picker & 2. Paste via useChatInputComposerActions
    const { result: composerResult, unmount: unmountComposer } = renderHook(() => useComposerActionsHarness());
    await act(async () => {
      await composerResult.current.handleFileSelect(asFileList(uniqueFiles(cap, 1)));
    });
    expect(toastSpy.show).not.toHaveBeenCalled();

    await act(async () => {
      await composerResult.current.handleFileSelect(asFileList(uniqueFiles(1, cap + 1)));
    });
    const pickerMessage = toastSpy.show.mock.calls[0]?.[1];
    expect(toastSpy.show).toHaveBeenLastCalledWith('warning', expectedMessage);

    toastSpy.show.mockClear();
    await act(async () => {
      await composerResult.current.handleImagePaste(
        new File(['extra-image'], 'extra.png', { type: 'image/png' }),
      );
    });
    const pasteMessage = toastSpy.show.mock.calls[0]?.[1];
    expect(toastSpy.show).toHaveBeenLastCalledWith('warning', expectedMessage);
    unmountComposer();

    // 3. Drop via useDragAndDrop
    toastSpy.show.mockClear();
    const { result: dropResult, unmount: unmountDrop } = renderHook(() => useDropHarness());
    await act(async () => {
      await dropResult.current.handleDrop(dropFilesEvent(uniqueFiles(cap, 1)));
    });
    expect(toastSpy.show).not.toHaveBeenCalled();

    await act(async () => {
      await dropResult.current.handleDrop(dropFilesEvent(uniqueFiles(1, cap + 1)));
    });
    const dropMessage = toastSpy.show.mock.calls[0]?.[1];
    expect(toastSpy.show).toHaveBeenLastCalledWith('warning', expectedMessage);
    unmountDrop();

    // 4. Imperative addAttachments via exported ChatInput handle (global drop zone)
    toastSpy.show.mockClear();
    const ref = createRef<ChatInputHandle>();
    const view = render(<ChatInput ref={ref} onSend={vi.fn()} />);
    act(() => {
      ref.current!.addAttachments(Array.from({ length: cap }, (_, i) => uniqueAttachment(i + 1)));
    });
    await waitFor(() => expect(screen.getAllByRole('group')).toHaveLength(cap));
    expect(toastSpy.show).not.toHaveBeenCalled();

    act(() => {
      ref.current!.addAttachments([uniqueAttachment(cap + 1)]);
    });
    const handleMessage = toastSpy.show.mock.calls[0]?.[1];
    expect(toastSpy.show).toHaveBeenLastCalledWith('warning', expectedMessage);
    expect(screen.getAllByRole('group')).toHaveLength(cap);

    expect(pickerMessage).toBe(expectedMessage);
    expect(pasteMessage).toBe(pickerMessage);
    expect(dropMessage).toBe(pickerMessage);
    expect(handleMessage).toBe(pickerMessage);
    view.unmount();
  });
});
