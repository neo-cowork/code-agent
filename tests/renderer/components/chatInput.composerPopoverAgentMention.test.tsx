// @vitest-environment jsdom
// ============================================================================
// N-FIX-COMPOSER-POPOVER-CLIPPED-SHORT-VIEWPORT 验收④（a）第 4 个挂点：
// ChatInput 内联 agent-mention 列表（@expert 前缀匹配打开的那层）同样走
// useComposerPopoverMaxHeight——maxHeight = composer 顶 − boundary 顶 − gap。
// 触发链路与生产一致：输入以 @ 开头的 query 命中专家候选后行内列表展开。
// ============================================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';
import type { AgentListEntry } from '../../../src/shared/contract/agentRegistry';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

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
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';

const SESSION_ID = 'session-popover-height';

const SESSION = {
  id: SESSION_ID,
  title: 'popover 高度会话',
  projectId: 'proj-1',
  modelConfig: { provider: 'openai', model: 'gpt-5' },
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
} as unknown as SessionWithMeta;

const EXPERT: AgentListEntry = {
  id: 'expert-alpha',
  name: 'AlphaExpert',
  description: 'test expert',
  source: 'user',
  modelTier: 'balanced',
  readonly: false,
  tools: [],
};

function editor(): HTMLElement {
  return screen.getByTestId('chat-composer-textarea');
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

// boundary 顶 48、composer-elevated anchor 顶 280 → 期望限高 280-48-8=224 < 旧上限 240。
const BOUNDARY_TOP = 48;
const ANCHOR_TOP = 280;

describe('ChatInput 内联 agent-mention 列表限高', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.hasAttribute('data-composer-popover-boundary')
        ? BOUNDARY_TOP
        : this.classList.contains('composer-elevated')
          ? ANCHOR_TOP
          : 0;
      return {
        x: 0, y: top, top, left: 0, right: 800,
        bottom: top + 40, width: 800, height: 40,
        toJSON: () => ({}),
      } as DOMRect;
    });

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
    useAgentRegistryStore.getState().setEntries([EXPERT]);
    mocks.listLibraryItems.mockResolvedValue([]);
    mocks.listProjects.mockResolvedValue([]);
    mocks.getProjectArtifacts.mockResolvedValue([]);
    mocks.getSessionPin.mockResolvedValue({ sessionId: SESSION_ID, itemIds: [] });
    mocks.setSessionPin.mockResolvedValue({ sessionId: SESSION_ID, itemIds: [] });
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
    vi.unstubAllGlobals();
    useSessionStore.setState({ sessions: [], currentSessionId: null, messages: [] });
    useAppStore.setState({ workingDirectory: null });
    useComposerStore.setState({ pendingPinItemIds: [] });
    useAgentRegistryStore.getState().setEntries([]);
  });

  it('矮空间时行内列表限高 = composer 顶 − boundary 顶 − gap（224 < 旧上限 240，证明按空间收缩）', async () => {
    render(
      <div data-composer-popover-boundary="">
        <ChatInput onSend={vi.fn(async () => true)} />
      </div>,
    );

    typeAtCaret('@alph');
    await waitFor(() => {
      expect(document.querySelector('[data-agent-mention-autocomplete]')).toBeTruthy();
    });

    const popover = document.querySelector('[data-agent-mention-autocomplete]') as HTMLElement;
    // 280 - 48 - 8 = 224 < 240：若是写死 240 这条必红。
    expect(popover.style.maxHeight).toBe('224px');
  });
});
