// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RoleFirstWakeSnapshot } from '../../../src/shared/contract/roleAssets';

const { getFirstWake, listRoles, listWakeProposals, emptyMessages } = vi.hoisted(() => ({
  getFirstWake: vi.fn(),
  listRoles: vi.fn(),
  listWakeProposals: vi.fn(),
  emptyMessages: [],
}));

vi.mock('../../../src/renderer/services/rolesClient', () => ({
  getFirstWake,
  listRoles,
  listWakeProposals,
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { on: () => () => {}, invokeDomain: vi.fn(async () => null) },
}));
vi.mock('../../../src/renderer/hooks/useAgent', () => ({
  useAgent: () => ({ messages: emptyMessages, sendMessage: vi.fn(), cancel: vi.fn() }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/components/features/chat/ChatInput', () => ({ ChatInput: () => null }));
vi.mock('../../../src/renderer/components/features/chat/TaskStatusBar', () => ({ TaskStatusBar: () => null }));
vi.mock('../../../src/renderer/components/features/chat/DecisionSlot', () => ({ DecisionSlot: () => null }));
vi.mock('../../../src/renderer/components/features/surfaceExecution/SurfaceExecutionChatPanel', () => ({ SurfaceExecutionChatPanel: () => null }));

import { ChatView } from '../../../src/renderer/components/ChatView';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const appState = useAppStore.getState();
const sessionState = useSessionStore.getState();
afterEach(() => {
  cleanup();
  useAppStore.setState(appState, true);
  useSessionStore.setState(sessionState, true);
});

it('ChatView: expert empty session shows both remaining first-wake suggestions and yields its welcome', async () => {
  const snapshot: RoleFirstWakeSnapshot = {
    state: 'completed',
    sourcesMode: 'connected',
    sources: ['日历'],
    sessionId: 'different-first-wake-session',
    intro: '可以帮你提前准备会议材料。',
    suggestions: [
      { title: '准备客户方案评审', prompt: '准备客户方案评审的材料清单' },
      { title: '准备季度计划讨论', prompt: '梳理季度计划讨论的重点和问题' },
    ],
  };
  let resolveSnapshot!: (value: RoleFirstWakeSnapshot) => void;
  getFirstWake.mockReturnValue(new Promise<RoleFirstWakeSnapshot>((resolve) => { resolveSnapshot = resolve; }));
  listRoles.mockResolvedValue([{ roleId: 'calendar-expert', displayName: '小历', description: '', source: 'user', memoryCount: 0, lastWork: null }]);
  listWakeProposals.mockResolvedValue([]);
  useAppStore.setState({ firstWakeCardRoleId: null });
  useSessionStore.setState({
    currentSessionId: 'empty-expert-session',
    messages: [],
    isLoading: false,
    isHydratingSession: false,
    sessions: [{
      id: 'empty-expert-session', title: '小历', messageCount: 0, turnCount: 0,
      createdAt: 1, updatedAt: 1,
      modelConfig: { provider: 'openai', model: 'gpt-5.4' },
      metadata: { expertThread: { roleId: 'calendar-expert', setAt: 1 } },
    }],
  });

  render(<ChatView />);

  expect(await screen.findByText('还没有对话。直接告诉它你想让它做什么。')).toBeTruthy();
  await act(async () => { resolveSnapshot(snapshot); });

  expect(await screen.findByTestId('role-first-wake-card')).toBeTruthy();
  for (const suggestion of snapshot.suggestions) {
    expect(screen.getByRole('button', { name: suggestion.title })).toBeTruthy();
  }
  expect(getFirstWake).toHaveBeenCalledWith('calendar-expert');
  await waitFor(() => {
    expect(screen.queryByTestId('chat-welcome-title')).toBeNull();
    expect(screen.queryByText('还没有对话。直接告诉它你想让它做什么。')).toBeNull();
  });
  expect(screen.queryByTestId('role-wake-proposals-card')).toBeNull();
  expect(useSessionStore.getState().messages).toHaveLength(0);
});
