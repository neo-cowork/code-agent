// @vitest-environment jsdom
// N-FIX-SIGNED-OUT-SEND-500-RAW-HTML-FU1 + N-FIX-ATTACHMENT-ONLY-SEND-MISSING-PROMPT-FU1-FAILURE-COPY-CHECK-FU1-FU1：
// 所有未进 host 运行期的发送失败轮统一收起轮头「遇到问题」徽章与红色「等待恢复」横幅；
// PROJECT_SOURCE_TRUST 只留信任句 + 确认按钮，其余发送失败保留用户气泡「没发出去 · 编辑重发」徽章与下一步提示句；
// 真正进入运行期后的失败仍显示红色恢复横幅；重发成功经 failedSendOutbox 合并后标记消失、恢复正常状态。
import React from 'react';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { REQUEST_INVALID } from '../../../src/shared/contract/agentRunErrors';
import { useAgentIPC } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TurnBasedTraceView } from '../../../src/renderer/components/features/chat/TurnBasedTraceView';
import {
  buildStreamingUiState,
  shouldShowStreamingState,
} from '../../../src/renderer/utils/streamingStatePresentation';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { mergeFailedSendOutbox } from '../../../src/renderer/stores/failedSendOutbox';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { projectSourceTrustCopy } from '../../../src/renderer/i18n/agentRunErrors';
import { languages, type Language } from '../../../src/renderer/i18n';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
    invokeDomain: vi.fn(),
    unsafeInvoke: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/hooks/useI18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/hooks/useI18n')>();
  const { languages: langs } = await import('../../../src/renderer/i18n');
  const { useAppStore: store } = await import('../../../src/renderer/stores/appStore');
  return { ...actual, useI18n: () => ({ t: langs[store((s) => s.language)] }) };
});

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return { Virtuoso: ReactModule.forwardRef(function Layout(props: {
    data: import('../../../src/shared/contract/trace').TraceTurn[];
    firstItemIndex: number;
    itemContent: (index: number, turn: import('../../../src/shared/contract/trace').TraceTurn) => React.ReactNode;
  }, ref) {
    ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex() {}, autoscrollToBottom() {} }));
    return <div>{props.data.map((turn, index) => <React.Fragment key={turn.turnId}>
      {props.itemContent(props.firstItemIndex + index, turn)}
    </React.Fragment>)}</div>;
  }) };
});

const SESSION_ID = 'session';
const PROMPT = '帮我把本周会议纪要整理成一份简短周报';

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  useAppStore.setState({ language: 'zh', isProcessing: false, processingSessionIds: new Set() });
  useSessionStore.setState({ currentSessionId: SESSION_ID, sessions: [], messages: [] });
  useSwarmStore.getState().reset();
  useTaskStore.setState({ sessionStates: { [SESSION_ID]: { status: 'idle' } } });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  useAppStore.setState({ language: 'zh', isProcessing: false, processingSessionIds: new Set() });
  useSessionStore.setState({ currentSessionId: null, sessions: [], messages: [] });
  useTaskStore.setState({ sessionStates: {} });
});

async function sendAndFail(language: Language, error: unknown) {
  useAppStore.setState({ language });
  invokeMock.mockRejectedValueOnce(error);
  const hook = renderHook(() => useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: SESSION_ID,
    currentTurnMessageIdRef: { current: null },
    isProcessing: false,
    setIsProcessing: vi.fn(),
    setSessionProcessing: useAppStore.getState().setSessionProcessing,
  }));
  await act(async () => {
    const delivery = await hook.result.current.sendMessage({
      content: PROMPT,
      sessionId: SESSION_ID,
      clientMessageId: 'u',
    });
    expect(delivery).toEqual({ outcome: 'failed' });
  });
  return hook;
}

describe('rejected-send vs runtime-error turn presentation', () => {
  it.each(['zh', 'en'] as const)('PROJECT_SOURCE_TRUST shows only the sentence and one confirm button in %s', async (language) => {
    await sendAndFail(
      language,
      Object.assign(new Error('Project folder needs trust confirmation'), {
        status: 422,
        code: 'PROJECT_SOURCE_TRUST',
      }),
    );
    const t = languages[language];
    const projection = projectTurns(useSessionStore.getState().messages, SESSION_ID, false);
    const { container } = render(<TurnBasedTraceView projection={projection} />);
    expect(screen.getAllByText(projectSourceTrustCopy[language])).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /确认并重发|Confirm and resend/ })).toHaveLength(1);
    const text = container.textContent ?? '';
    for (const banned of [
      t.turnCard.sendFailed, t.turnRun.status.blocked, t.turnRun.detail.blocked,
      '没发出去', '编辑重发', '遇到问题', '本轮运行遇到错误',
      'Not sent', 'Edit and resend', 'Ran into a problem',
    ]) expect(text).not.toContain(banned);
    expect(screen.queryByTestId('user-message-send-failed')).toBeNull();
    expect(screen.queryByTestId('user-message-edit-resend')).toBeNull();
    expect(screen.queryByTestId('turn-run-header')).toBeNull();
    expect(screen.queryByTestId('streaming-state-banner')).toBeNull();
  });

  const rejectedCases: ReadonlyArray<{
    name: string;
    createError: () => unknown;
    sentence: Record<Language, string>;
  }> = [
    {
      name: '400 REQUEST_INVALID',
      createError: () => Object.assign(new Error('Invalid sessionId'), { status: 400, code: REQUEST_INVALID }),
      sentence: {
        zh: '本地服务没有接受这次请求，请刷新页面后重试。',
        en: 'Neo could not accept this request. Refresh the page and try again.',
      },
    },
    {
      name: '429 rate limited',
      createError: () => Object.assign(new Error('Too Many Requests'), { status: 429 }),
      sentence: {
        zh: '发送太频繁了，请稍等片刻再重试。',
        en: 'Too many requests in a short time. Wait a moment and try again.',
      },
    },
    {
      name: '500 server error',
      createError: () => Object.assign(new Error('Internal Server Error'), { status: 500 }),
      sentence: {
        zh: 'Neo 暂时没能完成这次请求，请稍后再试。',
        en: 'Neo could not complete the request; please try again in a moment.',
      },
    },
    {
      name: 'network error (status 0)',
      createError: () => Object.assign(new TypeError('Failed to fetch'), { status: 0 }),
      sentence: {
        zh: 'Neo 暂时没能完成这次请求，请稍后再试。',
        en: 'Neo could not complete the request; please try again in a moment.',
      },
    },
  ];

  it.each(
    rejectedCases.flatMap((entry) => (['zh', 'en'] as const).map((language) => ({ ...entry, language }))),
  )('$name in $language hides the blocked header/banner while keeping the resend badge and bubble sentence', async ({ createError, sentence, language }) => {
    await sendAndFail(language, createError());
    expect(useTaskStore.getState().sessionStates[SESSION_ID]?.status).toBe('error');

    const t = languages[language];
    const projection = projectTurns(useSessionStore.getState().messages, SESSION_ID, false);
    const uiState = buildStreamingUiState({
      turn: projection.turns[0]!,
      t,
      isActiveTurn: false,
      sessionStatus: 'error',
    });
    expect(uiState.status).toBe('idle');
    expect(uiState.detail).toBe('');
    expect(shouldShowStreamingState(uiState)).toBe(false);

    const { container } = render(<TurnBasedTraceView projection={projection} />);
    const text = container.textContent ?? '';
    expect(screen.queryByTestId('turn-run-header')).toBeNull();
    expect(screen.queryByTestId('streaming-state-banner')).toBeNull();
    expect(text).not.toContain(t.turnRun.status.blocked);
    expect(text).not.toContain(t.turnRun.detail.blocked);
    expect(screen.getByTestId('user-message-send-failed')).toBeTruthy();
    expect(screen.getByTestId('user-message-edit-resend')).toBeTruthy();
    expect(text).toContain(t.turnCard.sendFailed);
    expect(text).toContain(t.turnCard.editAndResend);
    expect(screen.getByText(sentence[language])).toBeTruthy();
    expect(screen.queryByRole('button', { name: /确认并重发|Confirm and resend/ })).toBeNull();
  });

  it.each(['zh', 'en'] as const)('still shows the red blocked bar for a genuine run failure after host acceptance in %s', (language) => {
    useAppStore.setState({ language });
    useTaskStore.getState().updateSessionState(SESSION_ID, { status: 'error', error: 'stream aborted mid-turn' });
    const t = languages[language];
    const acceptedMessages: Message[] = [
      { id: 'u', role: 'user', content: PROMPT, timestamp: 1 },
      { id: 'a', role: 'assistant', content: '正在读取本周会议纪要', timestamp: 2 },
    ];
    const projection = projectTurns(acceptedMessages, SESSION_ID, false);
    projection.turns[0]!.status = 'error';

    const uiState = buildStreamingUiState({
      turn: projection.turns[0]!,
      t,
      isActiveTurn: false,
      sessionStatus: 'error',
    });
    expect(uiState.status).toBe('blocked');
    expect(uiState.detail).toBe(t.turnRun.detail.blocked);
    expect(shouldShowStreamingState(uiState)).toBe(true);

    const { container } = render(<TurnBasedTraceView projection={projection} />);
    expect(screen.getByTestId('turn-run-header')).toBeTruthy();
    expect(screen.getByTestId('streaming-state-banner')).toBeTruthy();
    expect(container.textContent).toContain(t.turnRun.status.blocked);
    expect(container.textContent).toContain(t.turnRun.detail.blocked);
    expect(screen.queryByTestId('user-message-send-failed')).toBeNull();
  });

  it('removes the send-failure marker after mergeFailedSendOutbox reconciles an accepted resend and restores normal states', async () => {
    await sendAndFail(
      'zh',
      Object.assign(new Error('Invalid sessionId'), { status: 400, code: REQUEST_INVALID }),
    );
    const restoredBeforeResend = mergeFailedSendOutbox(SESSION_ID, [], []);
    expect(restoredBeforeResend).toHaveLength(2);
    expect(restoredBeforeResend[0]?.metadata?.sendFailed).toBe(true);
    expect(restoredBeforeResend[1]?.metadata?.sendFailureCode).toBeTruthy();

    const persistedAfterResend: Message[] = [
      { id: 'u', role: 'user', content: PROMPT, timestamp: 3 },
      { id: 'reply', role: 'assistant', content: '本周三项重点进展已汇总如下。', timestamp: 4 },
    ];
    const merged = mergeFailedSendOutbox(
      SESSION_ID,
      useSessionStore.getState().messages,
      persistedAfterResend,
    );
    // mergeFailedSendOutbox 清掉 outbox 并移除本地错误消息，再合入服务端完成回复
    const timeline: Message[] = [
      ...merged,
      persistedAfterResend[1]!,
    ];
    expect(mergeFailedSendOutbox(SESSION_ID, [], [])).toEqual([]);
    for (const msg of timeline) {
      expect(msg.metadata?.sendFailureCode).toBeUndefined();
      expect(msg.metadata?.sendFailed).toBeUndefined();
    }

    const t = languages.zh;
    const streamingProjection = projectTurns([timeline[0]!], SESSION_ID, true);
    expect(buildStreamingUiState({
      turn: streamingProjection.turns[0]!,
      t,
      isActiveTurn: true,
      sessionStatus: 'running',
      isSessionProcessing: true,
    }).status).toBe('drafting');

    useTaskStore.getState().updateSessionState(SESSION_ID, { status: 'idle' });
    const completedProjection = projectTurns(timeline, SESSION_ID, false);
    expect(buildStreamingUiState({
      turn: completedProjection.turns[0]!,
      t,
      isActiveTurn: false,
      sessionStatus: 'idle',
    }).status).toBe('completed');

    render(<TurnBasedTraceView projection={completedProjection} />);
    expect(screen.getByText('本周三项重点进展已汇总如下。')).toBeTruthy();
    expect(screen.queryByTestId('user-message-send-failed')).toBeNull();
    expect(screen.queryByTestId('turn-run-header')).toBeNull();
    expect(screen.queryByTestId('streaming-state-banner')).toBeNull();
  });
});
