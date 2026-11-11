// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';

const invokeMock = vi.hoisted(() => vi.fn());
const invokeDomainMock = vi.hoisted(() => vi.fn());
const originalFetch = globalThis.fetch;

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
    invokeDomain: invokeDomainMock,
  },
}));

import { useAgentIPC } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { getAgentSendFailureMessage } from '../../../src/renderer/hooks/agent/agentRuntimeFollowup';
import { ProjectIdentityRecovery } from '../../../src/renderer/components/features/chat/ProjectIdentityRecovery';
import { useProjectIdentityRecoveryStore } from '../../../src/renderer/stores/projectIdentityRecoveryStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

const envelope: ConversationEnvelope = {
  content: '运行中补充要求',
  sessionId: 'session-queued',
};

function renderSendHook(options?: { isProcessing?: boolean }) {
  return renderHook(() => useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: 'session-queued',
    currentTurnMessageIdRef: { current: null },
    isProcessing: options?.isProcessing ?? false,
    setIsProcessing: vi.fn(),
    setSessionProcessing: useAppStore.getState().setSessionProcessing,
  }));
}

describe('useAgentIPC sendMessage silentFailure', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeDomainMock.mockReset();
    useSessionStore.setState({
      currentSessionId: 'session-queued',
      messages: [],
    });
    useSwarmStore.getState().reset();
    useAppStore.setState({
      isProcessing: false,
      processingSessionIds: new Set<string>(),
    });
    useTaskStore.setState({
      sessionStates: {
        'session-queued': { status: 'idle' },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('rejects without adding an assistant error or leaving the session busy', async () => {
    invokeMock.mockRejectedValueOnce(new Error('session already running'));
    const hook = renderSendHook();

    await act(async () => {
      await expect(
        hook.result.current.sendMessage(envelope, { silentFailure: true }),
      ).rejects.toThrow('session already running');
    });

    expect(
      useSessionStore.getState().messages.filter((message) => message.role === 'assistant'),
    ).toEqual([]);
    expect(useAppStore.getState().isSessionProcessing('session-queued')).toBe(false);
    expect(useTaskStore.getState().sessionStates['session-queued']?.status).toBe('idle');
  });

  it('preserves the existing visible error behavior when silentFailure is omitted', async () => {
    invokeMock.mockRejectedValueOnce(new Error('session already running'));
    const hook = renderSendHook();

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    const assistantMessages = useSessionStore.getState().messages.filter(
      (message) => message.role === 'assistant',
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toBe('Error: session already running');
    const userMessages = useSessionStore.getState().messages.filter((message) => message.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.metadata?.sendFailed).toBe(true);
    expect(userMessages[0]?.content).toBe('运行中补充要求');
    expect(useTaskStore.getState().sessionStates['session-queued']).toEqual({
      status: 'error',
      error: 'Error: session already running',
    });
  });

  it('同 clientMessageId 并发重发只打一次 host，时间线只有一条用户消息', async () => {
    let release!: () => void;
    invokeMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const hook = renderSendHook();
    const sameEnvelope: ConversationEnvelope = {
      ...envelope,
      clientMessageId: 'same-client-message',
    };

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = hook.result.current.sendMessage(sameEnvelope);
      second = hook.result.current.sendMessage(sameEnvelope);
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().messages.filter((message) => message.role === 'user')).toHaveLength(1);

    release();
    const deliveries = await Promise.all([first, second]);
    expect(deliveries).toEqual([{ outcome: 'sent' }, { outcome: 'sent' }]);
  });

  it('可见失败返回 failed，释放 pending 后同一键可以再发', async () => {
    invokeMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);
    const hook = renderSendHook();
    const retryEnvelope: ConversationEnvelope = {
      ...envelope,
      clientMessageId: 'retry-same-key',
    };

    let first: Awaited<ReturnType<typeof hook.result.current.sendMessage>> | undefined;
    await act(async () => {
      first = await hook.result.current.sendMessage(retryEnvelope);
    });
    expect(first).toEqual({ outcome: 'failed' });
    expect(useAppStore.getState().isSessionProcessing('session-queued')).toBe(false);

    let second: Awaited<ReturnType<typeof hook.result.current.sendMessage>> | undefined;
    await act(async () => {
      second = await hook.result.current.sendMessage(retryEnvelope);
    });
    expect(second).toEqual({ outcome: 'sent' });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('delivers to the foreground brain when the host says the session still has an active run', async () => {
    invokeMock.mockRejectedValueOnce(
      Object.assign(new Error('Neo 暂时无法接收请求，请稍后重试。'), { status: 409 }),
    );
    invokeDomainMock.mockResolvedValueOnce({ outcome: 'steered' });
    const hook = renderSendHook();

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(invokeDomainMock).toHaveBeenCalledWith(
      'domain:agent',
      'interrupt',
      expect.objectContaining({
        content: '运行中补充要求',
        sessionId: 'session-queued',
        context: expect.objectContaining({ runtimeInput: { mode: 'supplement' } }),
      }),
    );
    expect(
      useSessionStore.getState().messages.filter((message) => message.role === 'assistant'),
    ).toEqual([]);
    // 会话不能卡在 running/error，否则后续消息全进排队却没有 run 去消费
    expect(useTaskStore.getState().sessionStates['session-queued']?.status).toBe('idle');
  });

  it('preserves a queued envelope clientMessageId in the host payload', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const hook = renderSendHook();

    await act(async () => {
      await hook.result.current.sendMessage({
        ...envelope,
        clientMessageId: 'queued-message-id',
      });
    });

    expect(invokeMock).toHaveBeenCalledWith(
      'agent:send-message',
      expect.objectContaining({
        clientMessageId: 'queued-message-id',
      }),
    );
  });

  it('waits for durable-run readiness then resends the same visible user message', async () => {
    vi.useFakeTimers();
    invokeMock
      .mockRejectedValueOnce(Object.assign(
        new Error('cloud proxy request failed (503): durable run is starting'),
        { status: 503, code: 'DURABLE_RUN_ROLLOUT_UNAVAILABLE' },
      ))
      .mockResolvedValueOnce(undefined);
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ durableRunReady: false }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ durableRunReady: true }) });
    const hook = renderSendHook();

    let send: ReturnType<typeof hook.result.current.sendMessage> | undefined;
    await act(async () => {
      send = hook.result.current.sendMessage(envelope);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await send;
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[1]).toEqual([
      'agent:send-message',
      expect.objectContaining({ clientMessageId: useSessionStore.getState().messages[0]?.id }),
    ]);
    expect(useSessionStore.getState().messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(useSessionStore.getState().messages.filter((message) => message.role === 'assistant')).toEqual([]);
  });

  it('shows the localized failure only after durable-run readiness times out', async () => {
    vi.useFakeTimers();
    invokeMock.mockRejectedValueOnce(Object.assign(
      new Error('cloud proxy request failed (503): durable run is starting'),
      { status: 503, code: 'DURABLE_RUN_ROLLOUT_UNAVAILABLE' },
    ));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ durableRunReady: false }) });
    const hook = renderSendHook();

    let send: ReturnType<typeof hook.result.current.sendMessage> | undefined;
    await act(async () => {
      send = hook.result.current.sendMessage(envelope);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(90_000);
      await send;
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().messages.filter((message) => message.role === 'assistant')).toEqual([
      expect.objectContaining({ content: '服务还在启动，消息暂时没有发出。请稍后重试。' }),
    ]);
    expect(useTaskStore.getState().sessionStates['session-queued']).toMatchObject({ status: 'error' });
  });

  it('projects accepted foreground input without exposing a queue marker', async () => {
    invokeDomainMock.mockResolvedValueOnce({ outcome: 'queued', queuedInputId: 'buffered-input' });
    useAppStore.setState({
      isProcessing: true,
      processingSessionIds: new Set(['session-queued']),
    });
    const hook = renderSendHook({ isProcessing: true });

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(invokeDomainMock).toHaveBeenCalledWith(
      'domain:agent',
      'interrupt',
      expect.objectContaining({
        content: '运行中补充要求',
        clientMessageId: expect.any(String),
        sessionId: 'session-queued',
        context: expect.objectContaining({ runtimeInput: { mode: 'supplement' } }),
      }),
    );
    expect(useSessionStore.getState().messages.at(-1)).toMatchObject({
      role: 'user',
      content: '运行中补充要求',
      metadata: { workbench: { runtimeInputMode: 'supplement' } },
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('adds a visible assistant error when foreground input delivery fails', async () => {
    invokeDomainMock.mockRejectedValueOnce(new Error('foreground input unavailable'));
    useAppStore.setState({
      isProcessing: true,
      processingSessionIds: new Set(['session-queued']),
    });
    const hook = renderSendHook({ isProcessing: true });

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useSessionStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Error: foreground input unavailable',
    });
  });
});

describe('useAgentIPC signed-out project identity recovery', () => {
  const photoEnvelope: ConversationEnvelope = { content: '帮我把下载文件夹里的照片按日期改名', sessionId: 'photos', clientMessageId: 'original-message' };
  const sentence = '此文件夹需要重新确认，请确认信任后继续发送。';
  beforeEach(() => {
    invokeMock.mockReset(); invokeDomainMock.mockReset();
    useProjectIdentityRecoveryStore.setState({ entries: {} });
    useSessionStore.setState({ currentSessionId: 'photos', messages: [] });
    useAppStore.setState({ language: 'zh', isProcessing: false, processingSessionIds: new Set() });
    useTaskStore.setState({ sessionStates: { photos: { status: 'idle' } } });
  });
  afterEach(cleanup);
  async function failedSend() {
    invokeMock.mockRejectedValueOnce(Object.assign(new Error(sentence), { status: 422, code: 'PROJECT_SOURCE_IDENTITY_CONFIRM_REQUIRED',
      recoveryToken: '11111111-1111-4111-8111-111111111111' }));
    const hook = renderHook(() => useAgentIPC({ addMessage: useSessionStore.getState().addMessage, currentSessionId: 'photos',
      currentTurnMessageIdRef: { current: null }, isProcessing: false, setIsProcessing: vi.fn(),
      setSessionProcessing: useAppStore.getState().setSessionProcessing }));
    await act(async () => { await hook.result.current.sendMessage(photoEnvelope); });
    const message = useSessionStore.getState().messages.find(m => m.role === 'assistant');
    if (!message) throw new Error('Missing failure message');
    expect(message.content).toBe(sentence);
    render(<ProjectIdentityRecovery messageId={message.id} />);
    return message;
  }
  it('one confirm button records consent and automatically re-sends the exact original photoEnvelope once', async () => {
    const message = await failedSend();
    const original = invokeMock.mock.calls[0][1];
    expect(invokeDomainMock).not.toHaveBeenCalled(); expect(invokeMock).toHaveBeenCalledTimes(1);
    invokeDomainMock.mockResolvedValue({ confirmed: true }); invokeMock.mockResolvedValue(undefined);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认信任并发送' })); });
    expect(invokeDomainMock).toHaveBeenCalledWith('domain:project', 'confirmMissingSourceIdentity', {
      sessionId: 'photos', token: '11111111-1111-4111-8111-111111111111', confirmed: true,
    });
    expect(invokeMock).toHaveBeenCalledTimes(2); expect(invokeMock.mock.calls[1]).toEqual(['agent:send-message', original]);
    expect(useSessionStore.getState().messages.find(m => m.id === message.id)?.content).toBe('');
    expect(useSessionStore.getState().messages.filter(m => m.role === 'user')).toHaveLength(1);
  });
  it('decline closes the action while retaining the same sentence and the unsent original', async () => {
    const message = await failedSend(); fireEvent.click(screen.getByRole('button', { name: '暂不确认' }));
    expect(invokeDomainMock).not.toHaveBeenCalled(); expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '确认信任并发送' })).toBeNull();
    expect(useSessionStore.getState().messages.find(m => m.id === message.id)?.content).toBe(sentence);
    expect(useSessionStore.getState().messages.find(m => m.role === 'user')?.metadata?.sendFailed).toBe(true);
  });
  it('leaving the prompt unclicked has no consent or retry side effect', async () => {
    await failedSend(); cleanup();
    expect(invokeDomainMock).not.toHaveBeenCalled(); expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe('getAgentSendFailureMessage HTTP failure copy', () => {
  it('maps a send rejection that carries an HTML body and status to a safe sentence', () => {
    expect(getAgentSendFailureMessage(Object.assign(new Error('<html>PRIVATE</html>'), { status: 500 })))
      .toBe('Neo 暂时无法完成请求，请稍后重试。');
  });

  it.each([
    ['zh', '此文件夹需要重新确认，请确认信任后继续发送。', '项目文件夹需要重新确认，请在项目设置中检查并信任该文件夹后重试。'],
    ['en', 'This folder needs to be confirmed again; confirm trust to send your message.', 'The project folder needs confirmation; please review and trust it in project settings, then try again.'],
  ] as const)('keeps typed project trust refusals distinct from missing prompts in %s', (language, confirmation, trust) => {
    const original = useAppStore.getState().language;
    useAppStore.setState({ language });
    try {
      expect(getAgentSendFailureMessage(Object.assign(new Error('<html>PRIVATE</html>'), {
        status: 422, code: 'PROJECT_SOURCE_IDENTITY_CONFIRM_REQUIRED',
      }))).toBe(confirmation);
      expect(getAgentSendFailureMessage(Object.assign(new Error('identity_changed'), {
        status: 422, code: 'PROJECT_SOURCE_TRUST',
      }))).toBe(trust);
    } finally {
      useAppStore.setState({ language: original });
    }
  });
});
