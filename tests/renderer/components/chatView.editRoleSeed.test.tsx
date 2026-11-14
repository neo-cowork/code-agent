// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODELS } from '../../../src/shared/constants';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { Message } from '../../../src/shared/contract';

const { sendMessageMock, invokeDomainMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  invokeDomainMock: vi.fn(),
}));

vi.mock('../../../src/renderer/services/rolesClient', () => ({
  getFirstWake: vi.fn(async () => null),
  listRoles: vi.fn(async () => []),
  listWakeProposals: vi.fn(async () => []),
}));

vi.mock('../../../src/renderer/services/ipcService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/ipcService')>();
  return {
    ...actual,
    invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
    default: {
      ...actual.default,
      on: () => () => {},
      invoke: vi.fn(async () => null),
      invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
      unsafeInvoke: vi.fn(async () => null),
    },
  };
});

vi.mock('../../../src/renderer/hooks/useAgent', async () => {
  const { useSessionStore: store } = await import('../../../src/renderer/stores/sessionStore');
  return {
    useAgent: () => ({
      messages: store((state) => state.messages),
      sendMessage: sendMessageMock,
      cancel: vi.fn(),
    }),
  };
});

vi.mock('../../../src/renderer/hooks/useI18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/hooks/useI18n')>();
  const { languages } = await import('../../../src/renderer/i18n');
  const { useAppStore: appStore } = await import('../../../src/renderer/stores/appStore');
  return {
    ...actual,
    useI18n: () => {
      const language = appStore((state) => state.language);
      return { t: languages[language], language };
    },
  };
});

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return {
    Virtuoso: ReactModule.forwardRef(function Layout(props: {
      data: import('../../../src/shared/contract/trace').TraceTurn[];
      firstItemIndex: number;
      itemContent: (index: number, turn: import('../../../src/shared/contract/trace').TraceTurn) => React.ReactNode;
    }, ref) {
      ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex() {}, autoscrollToBottom() {} }));
      return (
        <div>
          {props.data.map((turn, index) => (
            <React.Fragment key={turn.turnId}>
              {props.itemContent(props.firstItemIndex + index, turn)}
            </React.Fragment>
          ))}
        </div>
      );
    }),
  };
});

vi.mock('../../../src/renderer/components/features/chat/ChatInput', () => ({ ChatInput: () => null }));
vi.mock('../../../src/renderer/components/features/chat/TaskStatusBar', () => ({ TaskStatusBar: () => null }));
vi.mock('../../../src/renderer/components/features/chat/DecisionSlot', () => ({ DecisionSlot: () => null }));
vi.mock('../../../src/renderer/components/features/surfaceExecution/SurfaceExecutionChatPanel', () => ({
  SurfaceExecutionChatPanel: () => null,
}));

import { ChatView } from '../../../src/renderer/components/ChatView';
import { startEditRoleChat } from '../../../src/renderer/utils/startEditRoleChat';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const initialAppState = useAppStore.getState();
const initialAuthState = useAuthStore.getState();
const initialSessionState = useSessionStore.getState();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as { domainAPI?: unknown }).domainAPI;
  useAppStore.setState(initialAppState, true);
  useAuthStore.setState(initialAuthState, true);
  useSessionStore.setState(initialSessionState, true);
});

describe('startEditRoleChat + ChatView deterministic seed path', () => {
  it('sends /edit-role <roleId> to the backend while rendering plain language in the user bubble', async () => {
    const configuredSettings = {
      models: {
        default: DEFAULT_MODELS.xiaomi,
        defaultProvider: 'xiaomi',
        providers: { xiaomi: { enabled: true, apiKeyConfigured: true } },
      },
    };

    invokeDomainMock.mockImplementation(async (domain: string, action: string, payload?: { title?: string }) => {
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
        return configuredSettings;
      }
      if (domain === IPC_DOMAINS.SESSION && action === 'create') {
        return {
          id: 'session-edit-role-seed',
          title: payload?.title ?? '',
          createdAt: 1,
          updatedAt: 1,
          messageCount: 0,
          turnCount: 0,
          modelConfig: { provider: 'xiaomi', model: DEFAULT_MODELS.xiaomi },
        };
      }
      if (domain === IPC_DOMAINS.SESSION && action === 'replayConversationBranch') {
        return { openRewindIds: [], messages: [] };
      }
      return null;
    });
    (window as unknown as { domainAPI?: unknown }).domainAPI = {
      invoke: async (domain: string, action: string, payload?: { title?: string }) => ({
        success: true,
        data: await invokeDomainMock(domain, action, payload),
      }),
    };

    sendMessageMock.mockImplementation(async (envelope: { content: string }) => {
      const storedUserMessage: Message = {
        id: 'msg-seed-1',
        role: 'user',
        content: envelope.content,
        timestamp: 10,
      };
      useSessionStore.getState().addMessage(storedUserMessage);
      return { outcome: 'started' };
    });

    useAuthStore.setState({ isAuthenticated: false });
    useAppStore.setState({ showSettings: true, language: 'zh', pendingRoleChatSeed: null });
    useSessionStore.setState({
      currentSessionId: null,
      sessions: [],
      messages: [],
      isLoading: false,
      isHydratingSession: false,
    });

    const { container } = render(<ChatView />);

    await act(async () => {
      await startEditRoleChat('研究员');
    });

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    const outboundEnvelope = sendMessageMock.mock.calls[0]![0] as { content: string };
    expect(outboundEnvelope.content).toBe('/edit-role 研究员');
    expect(outboundEnvelope.content.startsWith('/edit-role')).toBe(true);
    expect(useAppStore.getState().showSettings).toBe(false);
    expect(useAppStore.getState().pendingRoleChatSeed).toBeNull();
    expect(useSessionStore.getState().sessions[0]?.title).toBe('修改角色：研究员');

    expect(await screen.findByText('修改专家：研究员')).toBeTruthy();
    expect(container.textContent).not.toContain('/edit-role');
  });
});
