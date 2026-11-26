// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '../../../src/shared/contract';
import { UI } from '../../../src/shared/constants';
import { useFileUpload } from '../../../src/renderer/components/features/chat/ChatInput/useFileUpload';
import { useDragAndDrop } from '../../../src/renderer/components/features/chat/ChatInput/useDragAndDrop';
import { useChatInputComposerActions } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputComposerActions';

const warning = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/utils/logger', () => ({ createLogger: () => ({ warn: warning }) }));
vi.mock('../../../src/renderer/hooks/useToast', async (original) => ({
  ...await original<typeof import('../../../src/renderer/hooks/useToast')>(),
  toast: { show: vi.fn() },
}));

const discard = vi.fn<(...args: [string[]]) => Promise<void>>();
let paths: string[];
let sharedPath: string | undefined;
function useHarness() {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const upload = useFileUpload();
  const drop = useDragAndDrop({ ...upload, setAttachments, setIsUploading: vi.fn() });
  const select = useChatInputComposerActions({
    processFile: upload.processFile, inputAreaRef: { current: null }, setIsUploading: vi.fn(),
    attachmentCount: attachments.length, setAttachments, setValue: vi.fn(), setVoiceInputContext: vi.fn(),
  });
  return { attachments, ...drop, ...select };
}
function files(count: number, start = 0) {
  return Array.from({ length: count }, (_, i) => new File([`Reading notes ${start + i}`], `notes-${start + i}.txt`, { type: 'text/plain' }));
}
function dropped(items: File[]) {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { files: items, items: [] } } as unknown as React.DragEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  paths = [];
  sharedPath = undefined;
  discard.mockResolvedValue();
  Object.defineProperty(window, 'codeAgentAPI', { configurable: true, value: {
    getPathForFile: async (file: File) => {
      const path = sharedPath ?? `/tmp/uploads/upload-${paths.length}/${file.name}`;
      paths.push(path);
      return path;
    },
    discardUploadedFiles: discard,
  } });
});
afterEach(() => {
  cleanup();
  delete window.codeAgentAPI;
});

for (const entry of ['drop', 'select'] as const) {
  describe(`${entry} production entry rejects uploaded attachments`, () => {
    function send(actions: ReturnType<typeof useHarness>, items: File[]) {
      return entry === 'drop' ? actions.handleDrop(dropped(items)) : actions.handleFileSelect(items as unknown as FileList);
    }
    it('discards exactly ten duplicates and never the accepted path', async () => {
      const { result } = renderHook(useHarness);
      const [file] = files(1);
      await act(async () => { await send(result.current, [file]); });
      const kept = result.current.attachments[0].path;
      expect(discard).not.toHaveBeenCalled();
      await act(async () => { await send(result.current, Array(10).fill(file)); });
      expect(result.current.attachments).toHaveLength(1);
      expect(result.current.attachments[0].path).toBe(kept);
      expect(discard).toHaveBeenCalledWith(paths.slice(1));
      expect(discard.mock.calls.flatMap(([items]) => items)).not.toContain(kept);
    });
    it('discards exactly incoming over-cap paths when already full', async () => {
      const { result } = renderHook(useHarness);
      await act(async () => { await send(result.current, files(UI.MAX_ATTACHMENTS)); });
      const kept = result.current.attachments.map(a => a.path);
      expect(discard).not.toHaveBeenCalled();
      await act(async () => { await send(result.current, files(3, UI.MAX_ATTACHMENTS)); });
      expect(result.current.attachments.map(a => a.path)).toEqual(kept);
      expect(discard).toHaveBeenCalledWith(paths.slice(UI.MAX_ATTACHMENTS));
      expect(discard.mock.calls.flatMap(([items]) => items).some(path => kept.includes(path))).toBe(false);
    });
    it('cleans mixed overflow and duplicates while preserving same-name same-size different bytes', async () => {
      const { result } = renderHook(useHarness);
      const initial = files(UI.MAX_ATTACHMENTS - 1);
      await act(async () => { await send(result.current, initial); });
      const alternate = new File(['Reading notes X'], initial[0].name, { type: 'text/plain' });
      expect(alternate.size).toBe(initial[0].size);
      await act(async () => { await send(result.current, [initial[0], alternate, ...files(1, 99)]); });
      expect(result.current.attachments).toHaveLength(UI.MAX_ATTACHMENTS);
      expect(result.current.attachments.at(-1)?.data).toBe('Reading notes X');
      expect(discard).toHaveBeenCalledWith([paths[UI.MAX_ATTACHMENTS - 1], paths.at(-1)]);
    });
    it('never discards a rejected path shared with a kept native attachment', async () => {
      sharedPath = '/tmp/project/reading-notes.txt';
      const { result } = renderHook(useHarness);
      await act(async () => { await send(result.current, files(1)); });
      await act(async () => { await send(result.current, files(1)); });
      expect(result.current.attachments).toHaveLength(1);
      expect(discard).not.toHaveBeenCalled();
    });
    it('protects a kept sibling in the same uuid directory', async () => {
      const root = '/tmp/uploads/12345678-1234-1234-1234-123456789abc';
      sharedPath = `${root}/original.txt`;
      const { result } = renderHook(useHarness);
      const batch = files(1);
      await act(async () => { await send(result.current, batch); });
      sharedPath = `${root}/duplicate.txt`;
      await act(async () => { await send(result.current, batch); });
      expect(result.current.attachments).toHaveLength(1);
      expect(discard).not.toHaveBeenCalled();
    });
    it('keeps merging on native bridges without the optional discard capability', async () => {
      delete window.codeAgentAPI!.discardUploadedFiles;
      const { result } = renderHook(useHarness);
      const initial = files(UI.MAX_ATTACHMENTS);
      await act(async () => { await send(result.current, initial); });
      await act(async () => { await send(result.current, [initial[0], ...files(1, 99)]); });
      expect(result.current.attachments).toHaveLength(UI.MAX_ATTACHMENTS);
      expect(discard).not.toHaveBeenCalled();
    });
    it('logs a rejected cleanup promise without affecting accepted attachments', async () => {
      discard.mockRejectedValue(new Error('offline'));
      const { result } = renderHook(useHarness);
      const batch = files(1);
      await act(async () => { await send(result.current, batch); });
      await act(async () => { await send(result.current, batch); });
      expect(result.current.attachments).toHaveLength(1);
      expect(warning).toHaveBeenCalledWith('Failed to discard rejected uploads', { error: expect.any(Error) });
    });
  });
}

describe('draft restore production entry', () => {
  it('discards duplicate draft uploads while retaining every existing composer reference', async () => {
    const { useComposerDraftPersistence } = await import('../../../src/renderer/components/features/chat/ChatInput/useComposerDraftPersistence');
    const kept: MessageAttachment = { id: 'kept', name: 'notes.txt', type: 'file', category: 'text', mimeType: 'text/plain', size: 4, data: 'note', path: '/tmp/uploads/kept/notes.txt' };
    const duplicate = { ...kept, id: 'duplicate', path: '/tmp/uploads/rejected/notes.txt' };
    const key = 'neo.composerDraft.v1:discard-draft-test';
    // Mount before populating the saved draft, so the normal initial empty-composer effect cannot erase it.
    const setValue = vi.fn();
    const { result } = renderHook(() => {
      const [attachments, setAttachments] = useState<MessageAttachment[]>([kept]);
      const draft = useComposerDraftPersistence({
        sessionId: 'discard-draft-test', sessionless: false, value: '', setValue, attachments, setAttachments,
      });
      return { attachments, ...draft };
    });
    localStorage.setItem(key, JSON.stringify({ v: 2, text: '', attachments: [duplicate] }));
    act(() => result.current.putBack());
    expect(result.current.attachments).toEqual([kept]);
    expect(discard).toHaveBeenCalledWith([duplicate.path]);
    expect(discard.mock.calls.flatMap(([items]) => items)).not.toContain(kept.path);
    localStorage.removeItem(key);
  });
});
