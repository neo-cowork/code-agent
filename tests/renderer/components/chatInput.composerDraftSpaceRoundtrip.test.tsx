// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '../../../src/renderer/components/features/chat/ChatInput';
import { composerDraftStorageKey } from '../../../src/renderer/components/features/chat/ChatInput/composerDraftStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { DEFAULT_MODELS, DEFAULT_PROVIDER } from '../../../src/shared/constants';
import type { Message } from '../../../src/shared/contract';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const session: SessionWithMeta = {
  id: 'space-roundtrip',
  title: 'Community fundraiser',
  modelConfig: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.chat },
  createdAt: 1,
  updatedAt: 2,
  status: 'idle',
  messageCount: 2,
  turnCount: 1,
};
const history: Message[] = [
  { id: 'question', role: 'user', content: 'List supplies for the fundraiser.', timestamp: 1 },
  { id: 'reply', role: 'assistant', content: 'We need tables and price tags.', timestamp: 2 },
];
const draftKey = composerDraftStorageKey(session.id, false)!;
const onSend = () => false;

function AppComposerSlot() {
  const showProjectSpacePage = useAppStore((state) => state.showProjectSpacePage);
  return showProjectSpacePage ? <div data-testid="space-page-slot" /> : <ChatInput onSend={onSend} />;
}

describe('ChatInput drafts across a Space round trip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    useAppStore.getState().closeSecondaryPages();
    useAppStore.setState({ language: 'zh' });
    useSessionStore.setState({ currentSessionId: session.id, messages: history, sessions: [session] });
    vi.stubGlobal('domainAPI', {
      invoke: async (domain: string, action: string) => {
        if (domain === IPC_DOMAINS.SESSION && action === 'load') {
          return { success: true, data: { ...session, messages: history } };
        }
        if (
          (domain === IPC_DOMAINS.SESSION && action === 'getSessionTasks')
          || (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list')
        ) return { success: true, data: [] };
        return { success: false, error: { message: 'No host fixture for this action' } };
      },
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().closeSecondaryPages();
    useSessionStore.setState({ currentSessionId: null, messages: [], sessions: [] });
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    { label: 'plain text', draft: 'Add more tables.', passesThroughNull: false },
    { label: 'plain @ text', draft: 'See @fundraiser-supplies.', passesThroughNull: false },
    { label: 'multi-line text', draft: 'Order tables.\nPrint price tags.', passesThroughNull: false },
    { label: 'multi-line text when the hidden session id passes through null', draft: 'Order tables.\nPrint price tags.', passesThroughNull: true },
  ])('restores $label after the sidebar reopens the session', async ({ draft, passesThroughNull }) => {
    render(<AppComposerSlot />);
    const editor = screen.getByTestId('chat-composer-textarea');
    editor.textContent = draft;
    const selection = window.getSelection()!;
    selection.selectAllChildren(editor);
    selection.collapseToEnd();
    fireEvent.input(editor);

    // Leave before the debounce writes anything. Only the unmount can save this draft.
    expect(localStorage.getItem(draftKey)).toBeNull();
    act(() => useAppStore.getState().openProjectSpacePage());
    expect(screen.queryByTestId('space-page-slot')).not.toBeNull();
    expect(screen.queryByTestId('chat-composer-textarea')).toBeNull();
    expect(useSessionStore.getState().currentSessionId).toBe(session.id);

    if (passesThroughNull) {
      act(() => useSessionStore.setState({ currentSessionId: null, messages: [] }));
      expect(screen.queryByTestId('chat-composer-textarea')).toBeNull();
    }
    await act(async () => useSessionStore.getState().switchSession(session.id));

    expect(screen.queryByTestId('space-page-slot')).toBeNull();
    expect(useSessionStore.getState().messages).toEqual(history);
    expect(screen.getByTestId('chat-composer-textarea').textContent).toBe(draft);
    expect(screen.queryByRole('button', { name: zh.chatInput.unsentDraftPutBack })).toBeNull();
  });
});
