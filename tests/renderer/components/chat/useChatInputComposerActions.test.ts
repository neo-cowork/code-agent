// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '../../../../src/shared/contract';
import { UI } from '../../../../src/shared/constants';
import { useChatInputComposerActions } from '../../../../src/renderer/components/features/chat/ChatInput/useChatInputComposerActions';
import { useChatInputSubmit } from '../../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';
import { dismissAttachmentLimitToast } from '../../../../src/renderer/components/features/chat/ChatInput/attachmentMergeToast';
import { useComposerAttachmentLimitStore } from '../../../../src/renderer/stores/composerAttachmentLimitStore';
import { useAppStore } from '../../../../src/renderer/stores/appStore';
import { useComposerStore } from '../../../../src/renderer/stores/composerStore';

const send = vi.fn(async () => true);
const notice = () => useComposerAttachmentLimitStore.getState().notice;
const notes = (start: number, count: number) => Array.from({ length: count }, (_, i) =>
  new File([`Reading note ${start + i}: compare the chapter's evidence and conclusions.`], `reading-note-${start + i}.txt`, { type: 'text/plain' }),
);

function useComposer() {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [value, setValue] = useState('Summarize these reading notes in one page.');
  const inputAreaRef = useRef(null);
  const actions = useChatInputComposerActions({
    attachmentCount: attachments.length, setAttachments, setValue, inputAreaRef,
    setIsUploading: vi.fn(), setVoiceInputContext: vi.fn(),
    processFile: async (file) => ({
      id: file.name, name: file.name, size: file.size, type: 'file', category: 'text', mimeType: file.type,
    }),
  });
  const submit = useChatInputSubmit({
    value, attachments, voiceInputContext: null, pendingAppshot: null,
    pendingPromptCommand: null, pendingAgentSelection: null, currentSessionId: null,
    disabled: false, isProcessing: false, isUploading: false, onSend: send,
    agentEntries: [], buildEnvelope: (content, files) => ({ content, attachments: files }),
    openAgentCommand: vi.fn(), addToInputHistory: vi.fn(), clearAppshot: vi.fn(), inputAreaRef,
    setValue, setAttachments, setVoiceInputContext: vi.fn(),
    setPendingPromptCommand: vi.fn(), setPendingAgentSelection: vi.fn(), setScheduleComposerOpen: vi.fn(),
    openGoalConfirm: vi.fn(), closeGoalConfirm: vi.fn(), openSeedComposer: vi.fn(), setActiveAgentId: vi.fn(),
  });
  return { ...actions, ...submit, attachments, setAttachments };
}

describe('composer attachment limit notice lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    send.mockClear();
    useAppStore.setState({ language: 'en', cloudUIStrings: null });
    useComposerStore.setState({ pendingCommand: null, selectedTeamRecipeId: null });
    dismissAttachmentLimitToast();
  });
  afterEach(() => {
    cleanup();
    dismissAttachmentLimitToast();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function attachTwenty(result: { current: ReturnType<typeof useComposer> }) {
    // The public action only consumes Array.from(files); preserve that FileList shape.
    await act(async () => result.current.handleFileSelect(notes(1, 20) as unknown as FileList));
    expect(result.current.attachments).toHaveLength(UI.MAX_ATTACHMENTS);
    expect(notice()).not.toBeNull();
    act(() => vi.advanceTimersByTime(5 * 60 * 1000));
    expect(notice()).not.toBeNull();
  }

  it('keeps the warning on unchanged count, then removes it on a single removal', async () => {
    const { result, rerender } = renderHook(useComposer);
    await attachTwenty(result);
    rerender();
    expect(notice()).not.toBeNull();
    act(() => result.current.removeAttachment(result.current.attachments[0].id));
    expect(result.current.attachments).toHaveLength(UI.MAX_ATTACHMENTS - 1);
    expect(notice()).toBeNull();
  });

  it('removes the warning when all attachments are removed', async () => {
    const { result } = renderHook(useComposer);
    await attachTwenty(result);
    act(() => result.current.setAttachments([]));
    expect(result.current.attachments).toHaveLength(0);
    expect(notice()).toBeNull();
  });

  it('removes the warning when the public submit action sends and clears attachments', async () => {
    const { result } = renderHook(useComposer);
    await attachTwenty(result);
    await act(async () => result.current.handleSubmit());
    expect(send).toHaveBeenCalledOnce();
    expect(result.current.attachments).toHaveLength(0);
    expect(notice()).toBeNull();
  });

  it('replaces the warning with fresh numbers when another overflow keeps the count full', async () => {
    const { result } = renderHook(useComposer);
    await attachTwenty(result);
    expect(notice()).toMatchObject({ added: 10, dropped: 10 });
    await act(async () => result.current.handleFileSelect(notes(21, 3) as unknown as FileList));
    expect(result.current.attachments).toHaveLength(UI.MAX_ATTACHMENTS);
    expect(notice()).toEqual({ added: 0, dropped: 3, max: UI.MAX_ATTACHMENTS, kind: 'none' });
    act(() => vi.advanceTimersByTime(5 * 60 * 1000));
    expect(notice()).not.toBeNull();
  });
});
