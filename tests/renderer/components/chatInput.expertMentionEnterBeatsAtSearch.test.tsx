// @vitest-environment jsdom
import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

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

import { ChatInput, type ChatInputHandle } from '../../../src/renderer/components/features/chat/ChatInput';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import type { AgentListEntry } from '../../../src/shared/contract/agentRegistry';

const CURRENT_SESSION = {
  id: 'session-1', title: '当前会话', projectId: 'proj-1', modelConfig: {}, createdAt: 1, updatedAt: 1, messageCount: 0,
} as unknown as SessionWithMeta;

const EXPERT: AgentListEntry = {
  id: 'weekly-reporter', name: '周报整理员', description: '', source: 'user',
  modelTier: 'balanced', readonly: false, tools: [], profession: '行政助理',
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.localStorage.clear();
  useSessionStore.setState({ currentSessionId: 'session-1', sessions: [CURRENT_SESSION] });
  useAppStore.setState({ workingDirectory: null, activeAgentId: null });
  useAgentRegistryStore.setState({ entries: [] });
  mocks.listLibraryItems.mockResolvedValue([]);
  mocks.getSessionPin.mockResolvedValue({ sessionId: 'session-1', itemIds: [] });
  mocks.listProjects.mockResolvedValue([]);
  mocks.getProjectArtifacts.mockResolvedValue([]);
  (window as { domainAPI?: unknown }).domainAPI = {
    invoke: vi.fn().mockImplementation((domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SESSION && action === 'list') return Promise.resolve({ success: true, data: [] });
      if (domain === IPC_DOMAINS.AGENT && action === 'getTree') {
        return Promise.resolve({ success: true, data: { generatedAt: 0, roots: [], nodes: [], summary: { total: 0, running: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, withWorktree: 0, ownershipConflicts: [] } } });
      }
      if (domain === IPC_DOMAINS.DESKTOP && action === 'getManagedBrowserSession') return Promise.resolve({ success: true, data: { running: false, sessionId: null } });
      if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') return Promise.resolve({ success: true, data: [] });
      return Promise.resolve({ success: false, error: { code: 'NOT_MOCKED', message: 'not mocked in test' } });
    }),
  };
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessions: [], currentSessionId: null });
});

describe('@专家名：专家行优先于引用搜索消费 Enter', () => {
  it('@ 搜索已开/计时器在跑时专家列表才到，Enter 仍设上当前专家', async () => {
    render(<ChatInput ref={createRef<ChatInputHandle>()} onSend={vi.fn().mockResolvedValue(true)} />);
    const root = screen.getByTestId('chat-composer-textarea');
    root.insertBefore(document.createTextNode('@周报'), root.firstChild);
    fireEvent.input(root);
    // 此时注册表还空：走引用搜索，防抖计时器已排上
    act(() => { useAgentRegistryStore.getState().setEntries([EXPERT]); });
    await waitFor(() => expect(document.querySelector('div.popover-enter button')?.textContent).toContain('周报整理员'));
    fireEvent.keyDown(root, { key: 'Enter' });
    expect(useAppStore.getState().activeAgentId).toBe('weekly-reporter');
  });
});
