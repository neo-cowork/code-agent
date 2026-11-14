// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/shared/contract';
import type { TraceTurn } from '../../../../src/shared/contract/trace';
import type { ConversationEnvelope } from '../../../../src/shared/contract/conversationEnvelope';

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return {
    Virtuoso: ReactModule.forwardRef(function List(props: {
      data: TraceTurn[]; firstItemIndex: number;
      itemContent: (index: number, turn: TraceTurn) => React.ReactNode;
    }, ref) {
      ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn(), autoscrollToBottom: vi.fn() }));
      return <div role="log">{props.data.map((turn, index) => (
        <React.Fragment key={turn.turnId}>{props.itemContent(props.firstItemIndex + index, turn)}</React.Fragment>
      ))}</div>;
    }),
  };
});
vi.mock('../../../../src/renderer/components/features/chat/MessageBubble/MessageContent', () => ({
  MessageContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('../../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview', () => ({ AttachmentDisplay: () => null }));

import { TurnBasedTraceView } from '../../../../src/renderer/components/features/chat/TurnBasedTraceView';
import { projectTurns } from '../../../../src/renderer/hooks/useTurnProjection';
import { useSessionStore } from '../../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../../src/renderer/stores/appStore';
import { useTaskStore } from '../../../../src/renderer/stores/taskStore';
import { useMessageActionStore } from '../../../../src/renderer/stores/messageActionStore';
import { useComposerStore } from '../../../../src/renderer/stores/composerStore';
import { useChatInputSubmit, type UseChatInputSubmitParams } from '../../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';
import { ComposerCoreActions } from '../../../../src/renderer/components/features/chat/ChatInput/ComposerCoreActions';

const summary: Message = { id: 'summary', role: 'assistant', content: '已保存部分汇总，还有记录需要核对。', timestamp: 2000, metadata: { stoppedByStepLimit: true } };
const history: Message[] = [{ id: 'request', role: 'user', content: '汇总活动交接记录', timestamp: 1000 }, summary];
const send = vi.fn(async (envelope: ConversationEnvelope) => {
  useSessionStore.getState().addMessage({ id: envelope.clientMessageId ?? 'typed-user', role: 'user', content: envelope.content, timestamp: 3000 });
  return true;
});
function params(value = '', attachments: Message['attachments'] = []): UseChatInputSubmitParams {
  return {
    value, attachments, voiceInputContext: null, pendingAppshot: null,
    pendingPromptCommand: null, pendingAgentSelection: null, currentSessionId: 'session',
    disabled: false, isProcessing: false, isUploading: false, onSend: send,
    agentEntries: [], buildEnvelope: (content, files) => ({ content, attachments: files }),
    openAgentCommand: vi.fn(), addToInputHistory: vi.fn(), clearAppshot: vi.fn(), inputAreaRef: { current: null },
    setValue: vi.fn(), setAttachments: vi.fn(), setVoiceInputContext: vi.fn(),
    setPendingPromptCommand: vi.fn(), setPendingAgentSelection: vi.fn(), setScheduleComposerOpen: vi.fn(),
    openGoalConfirm: vi.fn(), closeGoalConfirm: vi.fn(), openSeedComposer: vi.fn(), setActiveAgentId: vi.fn(),
  };
}
function MessageList() {
  const messages = useSessionStore((state) => state.messages);
  return <TurnBasedTraceView projection={projectTurns(messages, 'session', false)} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  useSessionStore.setState({ currentSessionId: 'session', sessions: [], messages: [...history], runningSessionIds: new Set() });
  useAppStore.setState({ language: 'zh', processingSessionIds: new Set() });
  useTaskStore.setState({ sessionStates: {} });
  useComposerStore.setState({ pendingCommand: null, selectedTeamRecipeId: null });
  useMessageActionStore.getState().register(async (content, context) => { await send({ content, clientMessageId: context?.clientMessageId }); }, () => useSessionStore.getState().messages);
});
afterEach(() => { cleanup(); useMessageActionStore.getState().unregister(); vi.unstubAllGlobals(); });

describe('step-limit Continue in the production message list and composer', () => {
  it('shows under a marked last summary; click sends exactly one user message via the ordinary sender', async () => {
    render(<MessageList />);
    const button = await screen.findByRole('button', { name: '继续' });
    fireEvent.click(button);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({ content: '继续', clientMessageId: 'continue-summary' });
    expect(useSessionStore.getState().messages.filter((message) => message.content === '继续')).toHaveLength(1);
    expect(screen.queryByTestId('step-limit-continue')).toBeNull();
  });

  it('hides a marked summary when any later message exists', () => {
    useSessionStore.setState({ messages: [...history, { id: 'later', role: 'assistant', content: '另一个回复。', timestamp: 3000 }] });
    render(<MessageList />);
    expect(screen.queryByTestId('step-limit-continue')).toBeNull();
  });

  it.each(['processing', 'running', 'queued'] as const)('hides while this session is %s', (kind) => {
    if (kind === 'processing') useAppStore.setState({ processingSessionIds: new Set(['session']) });
    if (kind === 'running') useSessionStore.setState({ runningSessionIds: new Set(['session']) });
    if (kind === 'queued') useTaskStore.setState({ sessionStates: { session: { status: 'queued' } as never } });
    render(<MessageList />);
    expect(screen.queryByTestId('step-limit-continue')).toBeNull();
  });

  it('ordinary empty-send is enabled and triggers the same continuation', async () => {
    function Composer() {
      const submit = useChatInputSubmit(params());
      return <form onSubmit={submit.handleSubmit}>
        <ComposerCoreActions actions={['send']} voice={{} as never} sessionId="session" hasMessages configured isProcessing={false} hasContent={false} />
      </form>;
    }
    render(<Composer />);
    const button = screen.getByRole('button', { name: '发送消息' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0].content).toBe('继续');
  });

  it('typed-send sends the typed text rather than continuing', async () => {
    const { result } = renderHook(() => useChatInputSubmit(params('改成只列出待确认事项')));
    await act(async () => { await result.current.handleSubmit(); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].content).toBe('改成只列出待确认事项');
  });

  it('keeps Stop clickable through stopping and restores empty-send continuation after settling', () => {
    const stop = vi.fn();
    const composer = (processing: boolean, stopping: boolean) => (
      <ComposerCoreActions
        actions={[processing ? 'stop' : 'send']} voice={{} as never} sessionId="session"
        hasMessages configured disabled={processing} isProcessing={processing}
        isStopping={stopping} hasContent={false} onStop={stop}
      />
    );
    const { rerender } = render(composer(true, false));
    const before = screen.getByTestId('composer-stop-button') as HTMLButtonElement;
    expect(before.disabled).toBe(false);
    fireEvent.click(before);
    expect(stop).toHaveBeenCalledTimes(1);

    rerender(composer(true, true));
    const stopping = screen.getByTestId('composer-stop-stopping') as HTMLButtonElement;
    expect(stopping.disabled).toBe(false);
    expect(stopping.getAttribute('aria-label')).toBe('正在停止');
    expect(stopping.innerHTML).toContain('animate-spin');
    fireEvent.click(stopping);
    expect(stop).toHaveBeenCalledTimes(2);

    rerender(composer(false, false));
    expect(screen.queryByTestId('composer-stop-stopping')).toBeNull();
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the primary button as send (not Stop) when a draft exists while stopping', () => {
    const stop = vi.fn();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={submit}>
        <ComposerCoreActions
          actions={['send']} voice={{} as never} sessionId="session"
          hasMessages configured isProcessing isStopping hasContent onStop={stop}
        />
      </form>,
    );
    expect(screen.queryByTestId('composer-stop-stopping')).toBeNull();
    const send = screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it('empty-send without a marked summary remains a no-op', async () => {
    useSessionStore.setState({ messages: [history[0]] });
    const { result } = renderHook(() => useChatInputSubmit(params()));
    await act(async () => { await result.current.handleSubmit(); });
    expect(send).not.toHaveBeenCalled();
  });

  it('a run in another session does not hide Continue; English uses the localized user message', async () => {
    useSessionStore.setState({ runningSessionIds: new Set(['other']) });
    useAppStore.setState({ language: 'en' });
    render(<MessageList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0].content).toBe('Continue');
  });
});
