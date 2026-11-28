// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const lang = vi.hoisted(() => ({ current: 'zh' as 'zh' | 'en' }));
const readWorkspaceFileMock = vi.hoisted(() => vi.fn(async () => 'hello'));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: lang.current === 'zh' ? zh : en, language: lang.current }) };
});
vi.mock('../../../src/renderer/components/design/designFiles', () => ({
  readWorkspaceFile: readWorkspaceFileMock,
}));

import { ChatInput } from '../../../src/renderer/components/features/chat/ChatInput';
import { extractComposerPlainText } from '../../../src/renderer/components/features/chat/ChatInput/composerRichTextModel';
import { buildMentionAttachment } from '../../../src/renderer/components/features/chat/ChatInput/mentionAttachment';
import {
  getAttachmentDisplayName,
  getCollisionHoverTitles,
} from '../../../src/renderer/components/features/chat/ChatInput/attachmentDisplayName';
import { InlineComposerChip } from '../../../src/renderer/components/features/chat/ChatInput/InlineComposerChip';
import { AttachmentDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview';
import ipcService from '../../../src/renderer/services/ipcService';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import type { MessageAttachment } from '../../../src/shared/contract/message';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  readWorkspaceFileMock.mockClear();
  useAppStore.setState({ workingDirectory: null });
  useSessionStore.setState({ sessions: [], currentSessionId: null, messages: [] });
});

describe('buildMentionAttachment name', () => {
  it('name is the file name, path stays absolute', async () => {
    const att = await buildMentionAttachment({ path: '/tmp/x/y/a.txt', name: 'a.txt', workingDirectory: '/tmp/x' });
    expect(att.name).toBe('a.txt');
    expect(att.path).toBe('/tmp/x/y/a.txt');
  });

  it('builds a path-only folder attachment without reading file contents when isDirectory is true', async () => {
    const att = await buildMentionAttachment({
      path: '/tmp/at-proj/reports',
      name: 'reports',
      workingDirectory: '/tmp/at-proj',
      isDirectory: true,
    });
    expect(readWorkspaceFileMock).not.toHaveBeenCalled();
    expect(att).toMatchObject({
      type: 'file',
      category: 'folder',
      name: 'reports',
      path: '/tmp/at-proj/reports',
      data: '',
      size: 0,
      mimeType: 'inode/directory',
    });
  });
});

describe('ChatInput @ popover folder selection', () => {
  it('picks a folder row as an inline chip and folder attachment without inserting its absolute path', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    useBundledCapabilityStore.setState({
      installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
      states: [],
      loaded: true,
      error: null,
    });
    useAppStore.setState({ workingDirectory: '/tmp/at-proj' });
    useSessionStore.setState({
      sessions: [{
        id: 's-at-dir',
        title: 's-at-dir',
        workingDirectory: '/tmp/at-proj',
        modelConfig: { provider: 'openai', model: 'gpt-5' },
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
        turnCount: 0,
      } as SessionWithMeta],
      currentSessionId: 's-at-dir',
      messages: [],
    });
    const invokeDomain = ipcService.invokeDomain.bind(ipcService);
    vi.spyOn(ipcService, 'invokeDomain').mockImplementation((domain, action, payload) => {
      if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') return Promise.resolve([]);
      return invokeDomain(domain, action, payload);
    });
    const prevDomainAPI = (window as { domainAPI?: { invoke: (...args: unknown[]) => Promise<unknown> } }).domainAPI;
    (window as { domainAPI?: unknown }).domainAPI = {
      invoke: vi.fn().mockImplementation((domain: string, action: string, payload?: unknown) => {
        if (domain === IPC_DOMAINS.WORKSPACE && action === 'listFiles') {
          return Promise.resolve({
            success: true,
            data: [{ name: 'reports', path: '/tmp/at-proj/reports', isDirectory: true }],
          });
        }
        if (prevDomainAPI?.invoke) return prevDomainAPI.invoke(domain, action, payload);
        return Promise.resolve({ success: false });
      }),
    };

    try {
      const onSend = vi.fn(async (_envelope: ConversationEnvelope) => true);
      const { container, getByTestId } = render(<ChatInput onSend={onSend} />);
      const editor = getByTestId('chat-composer-textarea');

      editor.replaceChildren(document.createTextNode('@'));
      const selection = window.getSelection()!;
      selection.selectAllChildren(editor);
      selection.collapseToEnd();
      fireEvent.input(editor);

      const folderButton = await waitFor(() => {
        const popover = container.querySelector('[data-at-mention-popover]');
        expect(popover).toBeTruthy();
        const btn = Array.from(popover!.querySelectorAll('button')).find((el) => el.textContent?.includes('reports'));
        expect(btn).toBeTruthy();
        return btn!;
      });

      await act(async () => {
        fireEvent.click(folderButton);
      });

      await waitFor(() => {
        const chip = editor.querySelector('[data-inline-chip="file"]');
        expect(chip).toBeTruthy();
        expect(chip?.getAttribute('aria-label')).toBe('reports');
        expect(chip?.textContent).toContain('reports');
      });

      const plainText = extractComposerPlainText(editor);
      expect(plainText).not.toContain('/tmp/at-proj');
      expect(plainText).not.toContain('/Users/');
      expect(editor.textContent ?? '').not.toContain('/tmp/at-proj');
      expect(editor.textContent ?? '').not.toContain('/Users/');

      await act(async () => {
        fireEvent.submit(container.querySelector('form')!);
      });

      expect(onSend).toHaveBeenCalledTimes(1);
      const envelope = onSend.mock.calls[0]?.[0];
      expect(envelope?.content ?? '').not.toContain('/tmp/at-proj');
      expect(envelope?.content ?? '').not.toContain('/Users/');
      expect(envelope?.attachments).toEqual([
        expect.objectContaining({
          category: 'folder',
          name: 'reports',
          path: '/tmp/at-proj/reports',
          mimeType: 'inode/directory',
        }),
      ]);
    } finally {
      (window as { domainAPI?: unknown }).domainAPI = prevDomainAPI;
    }
  });
});

describe.each(['zh', 'en'] as const)('mention chip (%s)', (language) => {
  it('chip shows file name only, no absolute path', async () => {
    lang.current = language;
    const att = await buildMentionAttachment({ path: '/tmp/x/y/a.txt', name: 'a.txt', workingDirectory: '/tmp/x' });
    const { container } = render(
      <InlineComposerChip
        chip={{ key: `file:${att.id}`, kind: 'file', id: att.id, label: att.name, category: att.category }}
        onRemove={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('a.txt');
    expect(container.textContent).not.toContain('/tmp');
    expect(container.innerHTML).not.toContain('/tmp');
  });
});

describe('collision hover titles', () => {
  it('same names get relative titles, distinct names none', () => {
    const titles = getCollisionHoverTitles([
      { id: '1', name: 'notes.txt', path: '/ws/week1/notes.txt' },
      { id: '2', name: 'notes.txt', path: '/ws/archive/notes.txt' },
      { id: '3', name: 'other.txt', path: '/ws/other.txt' },
      { id: '4', name: '/legacy/dir/z.txt', path: '/legacy/dir/z.txt' },
    ], '/ws');
    expect(titles.get('1')).toBe('week1/notes.txt');
    expect(titles.get('2')).toBe('archive/notes.txt');
    expect(titles.has('3')).toBe(false);
    expect(titles.has('4')).toBe(false);
  });

  it('outside workspace uses parent folder, never absolute', () => {
    const titles = getCollisionHoverTitles([
      { id: '1', name: 'n.txt', path: '/a/b/n.txt' },
      { id: '2', name: 'n.txt', path: '/c/d/n.txt' },
    ], '/ws');
    expect(titles.get('1')).toBe('b/n.txt');
    expect(titles.get('2')).toBe('d/n.txt');
  });

  it('chip renders title attribute', () => {
    const { container } = render(
      <InlineComposerChip chip={{ key: 'file:1', kind: 'file', id: '1', label: 'n.txt', title: 'week1/n.txt' }} onRemove={vi.fn()} />,
    );
    expect(container.querySelector('[data-inline-chip="file"]')?.getAttribute('title')).toBe('week1/n.txt');
  });
});

describe('AttachmentPreview with legacy absolute-path name', () => {
  const make = (over: Partial<MessageAttachment>): MessageAttachment => ({
    id: 'a', type: 'file', category: 'pdf', name: '/tmp/x/y/a.pdf', size: 1, mimeType: 'x', path: '/tmp/x/y/a.pdf', ...over,
  } as MessageAttachment);

  it('pdf row', () => {
    const { container } = render(<AttachmentDisplay attachments={[make({})]} />);
    expect(container.textContent).toContain('a.pdf');
    expect(container.textContent).not.toContain('/tmp');
  });
  it('image row', () => {
    const { container } = render(<AttachmentDisplay attachments={[make({ type: 'image', category: 'image', name: '/tmp/x/y/a.png', path: '/tmp/x/y/a.png', data: 'data:image/png;base64,aGk=' })]} />);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('a.png');
  });
  it('csv row', () => {
    const { container } = render(<AttachmentDisplay attachments={[make({ type: 'file', category: 'data', name: '/tmp/x/y/a.csv', path: '/tmp/x/y/a.csv' })]} />);
    expect(container.textContent).toContain('a.csv');
    expect(container.textContent).not.toContain('/tmp');
  });
  it('folder-upload name unchanged', () => {
    expect(getAttachmentDisplayName('dir/f.txt')).toBe('dir/f.txt');
  });
});
