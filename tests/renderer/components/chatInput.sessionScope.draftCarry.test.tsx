// @vitest-environment jsdom
// 会话切换默认清空输入框；「选择文件夹」入口 hold 之后的那一次切换保留已敲文本。
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const storeState = vi.hoisted(() => ({ currentSessionId: 'a' as string | null, sessions: [] as unknown[] }));
vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const listeners = new Set<() => void>();
  const useSessionStore = Object.assign(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  );
  (globalThis as { __notify?: () => void }).__notify = () => listeners.forEach((l) => l());
  return { useSessionStore };
});
vi.mock('../../../src/renderer/stores/composerRejectedUploadsStore', () => ({
  useComposerRejectedUploadsStore: { getState: () => ({ clear: vi.fn() }) },
}));

import { useChatInputSessionScope } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSessionScope';
import {
  holdComposerDraftForNextSession,
  releaseComposerDraftHold,
} from '../../../src/renderer/components/features/chat/ChatInput/composerDraftStore';

afterEach(() => {
  releaseComposerDraftHold();
  storeState.currentSessionId = 'a';
});

function mount() {
  const setValue = vi.fn();
  const setAttachments = vi.fn();
  const view = renderHook(() => useChatInputSessionScope(setValue, setAttachments));
  return { view, setValue, setAttachments };
}

describe('useChatInputSessionScope draft carry', () => {
  it('clears the composer text on a plain session switch', () => {
    const { view, setValue } = mount();
    storeState.currentSessionId = 'b';
    act(() => view.rerender());
    expect(setValue).toHaveBeenCalledWith('');
  });

  it('keeps the typed text when the choose-folder entry holds the draft for the next switch', () => {
    const { view, setValue, setAttachments } = mount();
    holdComposerDraftForNextSession();
    storeState.currentSessionId = 'b';
    act(() => view.rerender());
    expect(setValue).not.toHaveBeenCalled();
    expect(setAttachments).toHaveBeenCalledWith([]);

    // hold 只放过一次：下一次切换照常清空
    storeState.currentSessionId = 'c';
    act(() => view.rerender());
    expect(setValue).toHaveBeenCalledWith('');
  });
});
