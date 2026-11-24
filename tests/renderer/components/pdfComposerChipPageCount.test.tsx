// @vitest-environment jsdom
// 同一份 1 页 PDF：composer 内联 chip（ChatInput → InlineComposerChip）和已发送气泡
// （AttachmentPreview）都要读出「PDF · 1 页」。页数还没出来时只留文件名。
import React, { createRef } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput, type ChatInputHandle } from '../../../src/renderer/components/features/chat/ChatInput';
import { AttachmentBar } from '../../../src/renderer/components/features/chat/ChatInput/AttachmentBar';
import { AttachmentDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { MessageAttachment } from '../../../src/shared/contract';
import ipcService from '../../../src/renderer/services/ipcService';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const SESSION = 'session-pdf-pages';

function pdf(pageCount?: number): MessageAttachment {
  return {
    id: 'contract-pdf',
    type: 'file',
    category: 'pdf',
    name: 'contract.pdf',
    size: 1200,
    mimeType: 'application/pdf',
    data: 'Contract page 1',
    ...(pageCount === undefined ? {} : { pageCount }),
  };
}

function makeSession(): SessionWithMeta {
  return {
    title: SESSION,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
    id: SESSION,
  } as SessionWithMeta;
}

/** 气泡把「PDF」「·」「1 页」拆在相邻 span 里，读出来仍是同一句。 */
function visibleSentence(root: ParentNode): string {
  return Array.from(root.querySelectorAll('span'))
    .map((span) => span.textContent?.trim() ?? '')
    .filter((text) => text.length > 0)
    .join(' ');
}

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
  useBundledCapabilityStore.setState({
    installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
    states: [],
    loaded: true,
    error: null,
  });
  const invokeDomain = ipcService.invokeDomain.bind(ipcService);
  vi.spyOn(ipcService, 'invokeDomain').mockImplementation((domain, action, payload) => {
    if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') return Promise.resolve([]);
    return invokeDomain(domain, action, payload);
  });
  useSessionStore.setState({
    sessions: [makeSession()],
    currentSessionId: SESSION,
    messages: [],
    pendingUserQuestionsBySessionId: new Map(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.setState({ language: 'zh' });
  useSessionStore.setState({ sessions: [], currentSessionId: null, messages: [], pendingUserQuestionsBySessionId: new Map() });
});

describe('PDF page sentence on the composer chip and the sent card', () => {
  it('renders PDF · 1 页 for the same 1-page contract in InlineComposerChip and AttachmentPreview', () => {
    const ref = createRef<ChatInputHandle>();
    const attachment = pdf(1);
    const { unmount } = render(<ChatInput ref={ref} onSend={() => true} />);
    expect(ref.current).toBeTruthy();
    act(() => { ref.current?.addAttachments([attachment]); });

    const chip = screen.getByRole('group', { name: 'contract.pdf' });
    expect(visibleSentence(chip)).toContain('PDF · 1 页');
    expect(chip.textContent).toContain('contract.pdf');
    unmount();

    render(<AttachmentDisplay attachments={[attachment]} />);
    expect(visibleSentence(document.body)).toContain('PDF · 1 页');
    expect(screen.getByText('contract.pdf')).toBeTruthy();
  });

  it('uses the english one-page sentence on the chip', () => {
    useAppStore.setState({ language: 'en' });
    const ref = createRef<ChatInputHandle>();
    render(<ChatInput ref={ref} onSend={() => true} />);
    act(() => { ref.current?.addAttachments([pdf(1)]); });

    const chip = screen.getByRole('group', { name: 'contract.pdf' });
    expect(chip.textContent).toContain('PDF · 1 page');
    expect(chip.textContent).not.toContain('pages');
  });

  it('shows only the file name when a PDF has no page count', () => {
    const ref = createRef<ChatInputHandle>();
    render(<ChatInput ref={ref} onSend={() => true} />);
    act(() => { ref.current?.addAttachments([pdf()]); });

    expect(screen.getByText('contract.pdf')).toBeTruthy();
    expect(document.body.textContent).not.toContain('PDF ·');
  });

  it('english AttachmentBar uses one page and the plural sentence', () => {
    useAppStore.setState({ language: 'en' });
    const { rerender } = render(<AttachmentBar attachments={[pdf(1)]} onRemove={() => {}} />);
    expect(document.body.textContent).toContain('PDF · 1 page');
    expect(document.body.textContent).not.toContain('pages');

    rerender(<AttachmentBar attachments={[{ ...pdf(3), id: 'contract-3' }]} onRemove={() => {}} />);
    expect(document.body.textContent).toContain('PDF · 3 pages');
  });
});
