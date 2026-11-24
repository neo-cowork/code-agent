// @vitest-environment jsdom
// 工作卡「接着做」：目标写入 → ChatView 上的发送包装走 submitNeoTagContinuation → 同卡续接。
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import type { ContinueNeoWorkCardResult } from '../../../src/shared/contract/tag';
import type { Message } from '../../../src/shared/contract';

const { sendMessageMock, captured } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(async () => ({ outcome: 'started' as const })),
  captured: {
    onSend: null as null | ((envelope: ConversationEnvelope) => Promise<boolean>),
  },
}));

vi.mock('../../../src/renderer/services/rolesClient', () => ({
  getFirstWake: vi.fn(async () => null),
  listRoles: vi.fn(async () => []),
  listWakeProposals: vi.fn(async () => []),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { on: () => () => {}, invoke: vi.fn(async () => null), invokeDomain: vi.fn(async () => null) },
}));
vi.mock('../../../src/renderer/hooks/useAgent', () => ({
  useAgent: () => ({ messages: [], sendMessage: sendMessageMock, cancel: vi.fn() }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { languages } = await import('../../../src/renderer/i18n');
  const { useAppStore } = await import('../../../src/renderer/stores/appStore');
  return {
    useI18n: () => {
      const language = useAppStore((state) => state.language);
      return { t: languages[language], language };
    },
  };
});
vi.mock('../../../src/renderer/components/features/chat/ChatInput', () => ({
  ChatInput: React.forwardRef(function CapturingChatInput(
    props: { onSend?: (envelope: ConversationEnvelope) => Promise<boolean> },
    _ref,
  ) {
    captured.onSend = props.onSend ?? null;
    return null;
  }),
}));
vi.mock('../../../src/renderer/components/features/chat/TaskStatusBar', () => ({ TaskStatusBar: () => null }));
vi.mock('../../../src/renderer/components/features/chat/DecisionSlot', () => ({ DecisionSlot: () => null }));
vi.mock('../../../src/renderer/components/features/surfaceExecution/SurfaceExecutionChatPanel', () => ({
  SurfaceExecutionChatPanel: () => null,
}));

import { ChatView } from '../../../src/renderer/components/ChatView';
import { NeoContinuationChip } from '../../../src/renderer/components/features/chat/ChatInput/NeoContinuationChip';
import { useNeoWorkCardContinuationSend } from '../../../src/renderer/components/features/chat/useNeoWorkCardContinuationSend';
import { toast } from '../../../src/renderer/hooks/useToast';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import { useNeoWorkCardStore } from '../../../src/renderer/stores/neoWorkCardStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

const appState = useAppStore.getState();
const authState = useAuthStore.getState();
const sessionState = useSessionStore.getState();
const originalContinueAndRun = useNeoWorkCardStore.getState().continueAndRun;

function sessionRecord(id: string) {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
  };
}

function continuationResult(roundTurnId = 'turn-round-2'): ContinueNeoWorkCardResult {
  return { roundTurnId, detail: { workCard: { id: 'card-1' } } } as ContinueNeoWorkCardResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.onSend = null;
  useAppStore.setState({ language: 'zh' });
  useAuthStore.setState({ user: { id: 'user-7', email: 'u@example.com' }, isAuthenticated: true });
  useSessionStore.setState({
    currentSessionId: 'sess-1',
    messages: [],
    sessions: [sessionRecord('sess-1')],
    isLoading: false,
    isHydratingSession: false,
  });
  useNeoWorkCardStore.setState({ continuationTarget: null, continueAndRun: originalContinueAndRun });
});

afterEach(() => {
  cleanup();
  useNeoWorkCardStore.setState({ continuationTarget: null, continueAndRun: originalContinueAndRun });
  useAppStore.setState(appState, true);
  useAuthStore.setState(authState, true);
  useSessionStore.setState(sessionState, true);
});

describe('useNeoWorkCardContinuationSend', () => {
  it('目标为空时原样透传，不调用 runContinuation', async () => {
    const send = vi.fn(async () => true);
    const continueAndRun = vi.fn();
    useNeoWorkCardStore.setState({ continuationTarget: null, continueAndRun });
    const { result } = renderHook(() => useNeoWorkCardContinuationSend(send));

    let sent = false;
    await act(async () => {
      sent = await result.current({ content: '普通消息' });
    });

    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledWith({ content: '普通消息' });
    expect(continueAndRun).not.toHaveBeenCalled();
  });

  it('目标属于别的会话时原样透传，不把这句话挂到那张卡上', async () => {
    const send = vi.fn(async () => true);
    const continueAndRun = vi.fn();
    useNeoWorkCardStore.setState({
      continuationTarget: { workCardId: 'card-stale', title: '旧卡', conversationId: 'sess-other' },
      continueAndRun,
    });
    const { result } = renderHook(() => useNeoWorkCardContinuationSend(send));

    await act(async () => {
      await result.current({ content: '这句不该续接' });
    });

    expect(continueAndRun).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(useNeoWorkCardStore.getState().continuationTarget?.workCardId).toBe('card-stale');
  });

  it('发往其他会话的消息不消耗当前会话的续接目标', async () => {
    const send = vi.fn(async () => true);
    const continueAndRun = vi.fn();
    useNeoWorkCardStore.setState({ continueAndRun });
    useNeoWorkCardStore.getState().setContinuationTarget({
      workCardId: 'card-1', title: '竞品摘要', conversationId: 'sess-1',
    });
    const { result } = renderHook(() => useNeoWorkCardContinuationSend(send));
    const envelope = { content: '普通消息', sessionId: 'sess-other' };

    await act(async () => {
      await result.current(envelope);
    });

    expect(send).toHaveBeenCalledWith(envelope);
    expect(continueAndRun).not.toHaveBeenCalled();
    expect(useNeoWorkCardStore.getState().continuationTarget?.workCardId).toBe('card-1');
  });

  it('切换会话后，旧请求返回时不补显到新会话或清掉新目标', async () => {
    const pending = Promise.withResolvers<ContinueNeoWorkCardResult>();
    useNeoWorkCardStore.setState({ continueAndRun: () => pending.promise });
    useNeoWorkCardStore.getState().setContinuationTarget({
      workCardId: 'card-1', title: '竞品摘要', conversationId: 'sess-1',
    });
    const { result } = renderHook(() => useNeoWorkCardContinuationSend(vi.fn(async () => true)));

    await act(async () => {
      const sent = result.current({ content: '再加一页结论' });
      await useSessionStore.getState().switchSession('sess-other');
      useNeoWorkCardStore.getState().setContinuationTarget({
        workCardId: 'card-2', title: '周报', conversationId: 'sess-other',
      });
      pending.resolve(continuationResult());
      expect(await sent).toBe(true);
    });

    expect(useSessionStore.getState().currentSessionId).toBe('sess-other');
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useNeoWorkCardStore.getState().continuationTarget?.workCardId).toBe('card-2');
  });

  it('失败时 toast 并保留目标，不透传', async () => {
    const send = vi.fn(async () => true);
    const continueAndRun = vi.fn(async () => {
      throw new Error('保存失败');
    });
    const toastError = vi.spyOn(toast, 'error').mockImplementation(() => 'toast-1');
    useNeoWorkCardStore.setState({
      continuationTarget: { workCardId: 'card-1', title: '竞品摘要', conversationId: 'sess-1' },
      continueAndRun,
    });
    const { result } = renderHook(() => useNeoWorkCardContinuationSend(send));

    let sent = true;
    await act(async () => {
      sent = await result.current({ content: '再加一页结论' });
    });

    expect(sent).toBe(false);
    expect(toastError).toHaveBeenCalledWith('保存失败');
    expect(send).not.toHaveBeenCalled();
    expect(useNeoWorkCardStore.getState().continuationTarget?.workCardId).toBe('card-1');
    toastError.mockRestore();
  });

  it('同一条 roundTurnId 已经在会话里时不再补一条本地消息', async () => {
    const existing: Message = { id: 'turn-round-2', role: 'user', content: '已经在了', timestamp: 1 };
    useSessionStore.setState({ messages: [existing] });
    const continueAndRun = vi.fn(async () => continuationResult());
    useNeoWorkCardStore.setState({
      continuationTarget: { workCardId: 'card-1', title: '竞品摘要', conversationId: 'sess-1' },
      continueAndRun,
    });
    const { result } = renderHook(() => useNeoWorkCardContinuationSend(vi.fn(async () => true)));

    await act(async () => {
      await result.current({ content: '再加一页结论' });
    });

    expect(useSessionStore.getState().messages).toEqual([existing]);
    expect(useNeoWorkCardStore.getState().continuationTarget).toBeNull();
  });

  it('未登录时 requesterUserId 用 local-user', async () => {
    useAuthStore.setState({ user: null });
    const continueAndRun = vi.fn(async () => continuationResult());
    useNeoWorkCardStore.setState({
      continuationTarget: { workCardId: 'card-1', title: '竞品摘要', conversationId: 'sess-1' },
      continueAndRun,
    });
    const { result } = renderHook(() => useNeoWorkCardContinuationSend(vi.fn(async () => true)));

    await act(async () => {
      await result.current({ content: '再加一页结论' });
    });

    expect(continueAndRun).toHaveBeenCalledWith(expect.objectContaining({ requesterUserId: 'local-user' }));
  });

  it('先写下目的地会话的目标，再切到那个会话，目标还在；再切走才清掉', async () => {
    useSessionStore.setState({ currentSessionId: 'sess-a', sessions: [sessionRecord('sess-a')] });
    renderHook(() => useNeoWorkCardContinuationSend(vi.fn(async () => true)));

    act(() => {
      useNeoWorkCardStore.setState({
        continuationTarget: { workCardId: 'card-1', title: '竞品摘要', conversationId: 'sess-b' },
      });
    });
    expect(useNeoWorkCardStore.getState().continuationTarget).toEqual({
      workCardId: 'card-1',
      title: '竞品摘要',
      conversationId: 'sess-b',
    });

    await act(async () => {
      await useSessionStore.getState().switchSession('sess-b');
    });
    expect(useNeoWorkCardStore.getState().continuationTarget?.conversationId).toBe('sess-b');

    await act(async () => {
      await useSessionStore.getState().switchSession('sess-c');
    });
    expect(useNeoWorkCardStore.getState().continuationTarget).toBeNull();
  });

  it('人已经在目标会话里，再切到别的会话，续接目标被清掉', async () => {
    useNeoWorkCardStore.setState({
      continuationTarget: { workCardId: 'card-1', title: '竞品摘要', conversationId: 'sess-1' },
    });
    renderHook(() => useNeoWorkCardContinuationSend(vi.fn(async () => true)));

    await act(async () => {
      await useSessionStore.getState().switchSession('sess-other');
    });

    expect(useNeoWorkCardStore.getState().continuationTarget).toBeNull();
  });
});

describe('ChatView 接着做发送', () => {
  it('设置续接目标→提交→走 submitNeoTagContinuation，runContinuation 收到这张卡的 workCardId', async () => {
    const continueAndRun = vi.fn(async () => continuationResult());
    useNeoWorkCardStore.setState({
      continuationTarget: { workCardId: 'card-1', title: '竞品摘要', conversationId: 'sess-1' },
      continueAndRun,
    });

    render(<ChatView />);
    expect(captured.onSend).toEqual(expect.any(Function));

    let sent = false;
    await act(async () => {
      sent = await captured.onSend!({
        content: '再加一页结论',
        clientMessageId: 'cm-1',
        attachments: [{ id: 'att-1', type: 'image', name: 'note.png', category: 'image', mimeType: 'image/png', size: 1 }],
      });
    });

    expect(sent).toBe(true);
    expect(continueAndRun).toHaveBeenCalledTimes(1);
    expect(continueAndRun).toHaveBeenCalledWith({
      workCardId: 'card-1',
      conversationId: 'sess-1',
      userText: '再加一页结论',
      requesterUserId: 'user-7',
      selectedArtifactIds: ['att-1'],
      clientSourceMessageId: 'cm-1',
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(useNeoWorkCardStore.getState().continuationTarget).toBeNull();
    expect(useSessionStore.getState().messages).toEqual([
      expect.objectContaining({
        id: 'turn-round-2',
        role: 'user',
        content: '再加一页结论',
        metadata: {
          neoTag: {
            workCardId: 'card-1',
            sourceConversationId: 'sess-1',
            sourceTurnId: 'turn-round-2',
          },
        },
      }),
    ]);
  });
});

describe('NeoContinuationChip', () => {
  it('只在目标会话与当前会话一致时显示；点 × 清掉目标', () => {
    const view = render(<NeoContinuationChip />);
    expect(screen.queryByTestId('neo-continuation-chip')).toBeNull();

    act(() => {
      useNeoWorkCardStore.setState({
        continuationTarget: { workCardId: 'card-1', title: '竞品摘要', conversationId: 'sess-other' },
      });
    });
    view.rerender(<NeoContinuationChip />);
    expect(screen.queryByTestId('neo-continuation-chip')).toBeNull();

    act(() => {
      useNeoWorkCardStore.setState({
        continuationTarget: { workCardId: 'card-1', title: '竞品摘要', conversationId: 'sess-1' },
      });
    });
    view.rerender(<NeoContinuationChip />);
    const chip = screen.getByTestId('neo-continuation-chip');
    expect(chip.textContent).toContain('续接 · ');
    expect(chip.textContent).toContain('竞品摘要');

    fireEvent.click(screen.getByRole('button', { name: '移除续接' }));
    expect(useNeoWorkCardStore.getState().continuationTarget).toBeNull();
    expect(screen.queryByTestId('neo-continuation-chip')).toBeNull();
  });

  it('英文界面用 Continuing 前缀', () => {
    useAppStore.setState({ language: 'en' });
    useNeoWorkCardStore.setState({
      continuationTarget: { workCardId: 'card-1', title: 'Competitor summary', conversationId: 'sess-1' },
    });
    render(<NeoContinuationChip />);
    const chip = screen.getByTestId('neo-continuation-chip');
    expect(chip.textContent).toContain('Continuing · ');
    expect(chip.textContent).toContain('Competitor summary');
    expect(screen.getByRole('button', { name: 'Remove continuation' })).toBeTruthy();
  });
});
