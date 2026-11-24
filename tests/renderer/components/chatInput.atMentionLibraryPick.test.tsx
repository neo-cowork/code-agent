// @vitest-environment jsdom
//
// FB-2793：@ 面板选中资料库行必须关掉面板、清掉 @query、只钉上一条。
// 下一次 Enter 走发送，不再把同一行取消钉住。

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryItem } from '../../../src/shared/contract/library';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';
import { notifyLibraryPinChanged } from '../../../src/renderer/components/features/knowledge/libraryPinEvents';

const mocks = vi.hoisted(() => ({
  listLibraryItems: vi.fn(),
  getSessionPin: vi.fn(),
  setSessionPin: vi.fn(),
  listProjects: vi.fn(),
  getProjectArtifacts: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useToast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/hooks/useToast')>()),
  toast: { show: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh, language: 'zh' }) }));
vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: mocks.listLibraryItems,
  getSessionPin: mocks.getSessionPin,
  setSessionPin: mocks.setSessionPin,
}));
vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjects: mocks.listProjects,
  getProjectArtifacts: mocks.getProjectArtifacts,
}));

import { ChatInput } from '../../../src/renderer/components/features/chat/ChatInput';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const SESSION_ID = 'session-lib-pick';
const LIB_ID = 'lib-xyz';
const LIB_TITLE = 'xyz briefing';

const SESSION = {
  id: SESSION_ID,
  title: '资料会话',
  projectId: 'proj-1',
  modelConfig: { provider: 'openai', model: 'gpt-5' },
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
} as unknown as SessionWithMeta;

function libraryItem(): LibraryItem {
  return {
    id: LIB_ID,
    projectId: 'proj-1',
    title: LIB_TITLE,
    kind: 'upload',
    pathOrUri: '/lib/xyz-briefing.md',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

let pinnedIds: string[] = [];

function editor(): HTMLElement {
  return screen.getByTestId('chat-composer-textarea');
}

function plainText(): string {
  return editor().getAttribute('data-plain-text') ?? '';
}

function libraryChips(): Element[] {
  return Array.from(editor().querySelectorAll('[data-composer-chip-key^="library:"]'));
}

function typeAtCaret(text: string): void {
  const root = editor();
  root.appendChild(document.createTextNode(text));
  const selection = window.getSelection();
  if (!selection) throw new Error('missing selection');
  selection.selectAllChildren(root);
  selection.collapseToEnd();
  fireEvent.input(root);
}

describe('资料库 @ 选中关闭面板且下一次 Enter 发送', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    pinnedIds = [];
    useSessionStore.setState({ currentSessionId: SESSION_ID, sessions: [SESSION], messages: [] });
    useAppStore.setState({ workingDirectory: null });
    useComposerStore.setState({
      selectedSkillIds: [],
      selectedConnectorIds: [],
      selectedMcpServerIds: [],
      turnCapabilityScopeMode: 'auto',
      pendingPinItemIds: [],
      pendingCommand: null,
    });
    mocks.listLibraryItems.mockResolvedValue([libraryItem()]);
    mocks.listProjects.mockResolvedValue([{ id: 'proj-1', name: 'Neo 项目' }]);
    mocks.getProjectArtifacts.mockResolvedValue([]);
    mocks.getSessionPin.mockClear();
    mocks.setSessionPin.mockClear();
    mocks.getSessionPin.mockImplementation(async () => ({ sessionId: SESSION_ID, itemIds: [...pinnedIds] }));
    mocks.setSessionPin.mockImplementation(async (sessionId: string, itemIds: string[]) => {
      pinnedIds = [...itemIds];
      notifyLibraryPinChanged(sessionId);
      return { sessionId, itemIds: [...pinnedIds] };
    });
    (window as { domainAPI?: unknown }).domainAPI = {
      invoke: vi.fn().mockImplementation((domain: string, action: string) => {
        if (domain === IPC_DOMAINS.SESSION && action === 'list') {
          return Promise.resolve({ success: true, data: [] });
        }
        if (domain === IPC_DOMAINS.AGENT && action === 'getTree') {
          return Promise.resolve({
            success: true,
            data: {
              generatedAt: 0,
              roots: [],
              nodes: [],
              summary: { total: 0, running: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, withWorktree: 0, ownershipConflicts: [] },
            },
          });
        }
        if (domain === IPC_DOMAINS.DESKTOP && action === 'getManagedBrowserSession') {
          return Promise.resolve({ success: true, data: { running: false, sessionId: null } });
        }
        if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') {
          return Promise.resolve({ success: true, data: [] });
        }
        return Promise.resolve({ success: false, error: { code: 'NOT_MOCKED', message: 'not mocked in test' } });
      }),
    };
  });

  afterEach(() => {
    cleanup();
    useSessionStore.setState({ sessions: [], currentSessionId: null, messages: [] });
    useAppStore.setState({ workingDirectory: null });
    useComposerStore.setState({ pendingPinItemIds: [] });
  });

  async function openLibraryRow(): Promise<void> {
    typeAtCaret('@xyz');
    await waitFor(() => {
      expect(document.querySelector('[data-at-mention-popover]')).toBeTruthy();
    });
  }

  it('输入 @xyz 后 Enter 清掉触发词、留下 1 颗资料库 chip，再 Enter 走发送且 pin 仍是 1', async () => {
    const onSend = vi.fn(async () => true);
    render(<ChatInput onSend={onSend} />);
    await openLibraryRow();

    await act(async () => {
      fireEvent.keyDown(editor(), { key: 'Enter', keyCode: 13 });
    });

    await waitFor(() => {
      expect(plainText()).not.toContain('@xyz');
      expect(libraryChips()).toHaveLength(1);
      expect(document.querySelector('[data-at-mention-popover]')).toBeNull();
    });
    expect(pinnedIds).toEqual([LIB_ID]);
    expect(mocks.setSessionPin).toHaveBeenCalledTimes(1);

    typeAtCaret('summarize this file in 3 bullets');
    await waitFor(() => expect(plainText()).toContain('summarize this file in 3 bullets'));
    await act(async () => {
      fireEvent.keyDown(editor(), { key: 'Enter', keyCode: 13 });
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(pinnedIds).toEqual([LIB_ID]);
    expect(libraryChips()).toHaveLength(1);
    expect(document.querySelector('[data-at-mention-popover]')).toBeNull();
  });

  it('已钉住的资料库行再选一次只清掉 @query，chip 仍是 1 颗', async () => {
    pinnedIds = [LIB_ID];
    const onSend = vi.fn(async () => true);
    render(<ChatInput onSend={onSend} />);
    await waitFor(() => expect(libraryChips()).toHaveLength(1));

    await openLibraryRow();
    expect(document.querySelector('[aria-label="已带入对话"]')).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(editor(), { key: 'Enter', keyCode: 13 });
    });

    await waitFor(() => {
      expect(plainText()).not.toContain('@xyz');
    });
    expect(libraryChips()).toHaveLength(1);
    expect(pinnedIds).toEqual([LIB_ID]);
    expect(mocks.setSessionPin).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('面板里的 pin 集合过期（chip × 已取消）时再选同一行会重新钉上', async () => {
    pinnedIds = [LIB_ID];
    render(<ChatInput onSend={vi.fn(async () => true)} />);
    await waitFor(() => expect(libraryChips()).toHaveLength(1));
    await openLibraryRow();
    pinnedIds = [];
    await act(async () => {
      fireEvent.keyDown(editor(), { key: 'Enter', keyCode: 13 });
    });
    await waitFor(() => expect(mocks.setSessionPin).toHaveBeenCalledTimes(1));
    expect(pinnedIds).toEqual([LIB_ID]);
    expect(plainText()).not.toContain('@xyz');
  });

  it.each([
    ['光标在触发词中间', 3],
    ['光标在 @ 前面', 0],
  ])('%s时 Enter 仍清掉整段 @xyz', async (_name, offset) => {
    render(<ChatInput onSend={vi.fn(async () => true)} />);
    await openLibraryRow();
    const node = Array.from(editor().childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes('@xyz'));
    if (!node) throw new Error('missing text node');
    window.getSelection()?.collapse(node, offset);
    await act(async () => {
      fireEvent.keyDown(editor(), { key: 'Enter', keyCode: 13 });
    });
    await waitFor(() => expect(plainText()).not.toMatch(/@|xyz|^z$/));
    expect(libraryChips()).toHaveLength(1);
  });
});
