// @vitest-environment jsdom
// N-FIX-SEND-HANGS-WHEN-PARKED-RUN-SUPERSEDE-FAILS-FU1-FU1-FIX：409 RUN_SESSION_CONFLICT 失败说明点名的
// 「放弃 / 重试」必须真有按钮；放弃走 agent:cancel + abandonParked；重试走原 clientMessageId 重发，
// 再被拒时新说明替换旧说明（始终只有一条）。失败节点来自 useAgentIPC 真实发送失败路径。
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentIPC } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TurnBasedTraceView } from '../../../src/renderer/components/features/chat/TurnBasedTraceView';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { clearFailedSend } from '../../../src/renderer/stores/failedSendOutbox';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { httpFailureMessage } from '../../../src/renderer/utils/httpFailureMessage';
import { type Language } from '../../../src/renderer/i18n';
import { sessionConflictLabels } from '../../../src/renderer/i18n/projectTrust';

const invokeMock = vi.hoisted(() => vi.fn());
const invokeDomainMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: invokeMock, invokeDomain: invokeDomainMock, unsafeInvoke: vi.fn() },
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
const PROMPT = 'summarize notes.txt into 3 points';
// 真实链路：/api/run 撞 409 → 改走 /api/interrupt，后者再回 409 + RUN_SESSION_CONFLICT，
// transport 把信封换成人话并保留业务码（DomainInvokeError 形状）。
function rejectSendAsConflict(language: Language) {
  invokeMock.mockRejectedValueOnce(Object.assign(new Error('409'), { status: 409, code: 'RUN_SESSION_CONFLICT' }));
  invokeDomainMock.mockRejectedValueOnce(Object.assign(
    new Error(httpFailureMessage({ status: 409, code: 'RUN_SESSION_CONFLICT', language })),
    { code: 'RUN_SESSION_CONFLICT' },
  ));
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeDomainMock.mockReset();
  localStorage.clear();
  clearFailedSend(SESSION_ID);
  useAppStore.setState({ language: 'zh', isProcessing: false, processingSessionIds: new Set() });
  useSessionStore.setState({ currentSessionId: SESSION_ID, sessions: [], messages: [] });
  useSwarmStore.getState().reset();
  useTaskStore.setState({ sessionStates: { [SESSION_ID]: { status: 'idle' } } });
});
afterEach(() => {
  cleanup();
  useMessageActionStore.getState().unregister();
  localStorage.clear();
  clearFailedSend(SESSION_ID);
  useAppStore.setState({ language: 'zh' });
  useSessionStore.setState({ currentSessionId: null, sessions: [], messages: [] });
  useTaskStore.setState({ sessionStates: {} });
});

async function sendAndConflict(language: Language) {
  useAppStore.setState({ language });
  rejectSendAsConflict(language);
  const hook = renderHook(() => useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: SESSION_ID,
    currentTurnMessageIdRef: { current: null },
    isProcessing: false,
    setIsProcessing: vi.fn(),
    setSessionProcessing: useAppStore.getState().setSessionProcessing,
  }));
  await act(async () => {
    expect(await hook.result.current.sendMessage({ content: PROMPT, sessionId: SESSION_ID, clientMessageId: 'u1' }))
      .toEqual({ outcome: 'failed' });
  });
  return hook;
}

const view = () => render(
  <TurnBasedTraceView projection={projectTurns(useSessionStore.getState().messages, SESSION_ID, false)} />,
);

describe('RUN_SESSION_CONFLICT failure note actions', () => {
  it.each(['zh', 'en'] as const)('labels the note names are exactly the rendered controls (%s)', async (language) => {
    await sendAndConflict(language);
    const { container } = view();
    const note = httpFailureMessage({ status: 409, code: 'RUN_SESSION_CONFLICT', language });
    const quoted = [...note.matchAll(/[「"]([^」"]+)[」"]/g)].map((m) => m[1]);
    const labels = sessionConflictLabels[language];
    expect(quoted.sort()).toEqual([labels.abandon, labels.retry].sort());
    const actions = screen.getByTestId('session-conflict-actions');
    const rendered = [...actions.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(rendered.sort()).toEqual(quoted.sort());
    expect(container.textContent).toContain(note);
    expect(screen.getByTestId('user-message-edit-resend')).toBeTruthy();
  });

  it('Abandon cancels the old run with abandonParked and reports done', async () => {
    await sendAndConflict('zh');
    view();
    invokeMock.mockResolvedValueOnce({ message: 'Cancelled', runId: 'r1' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '放弃' })); });
    expect(invokeMock).toHaveBeenLastCalledWith('agent:cancel', { sessionId: SESSION_ID, abandonParked: true });
    expect(screen.getByRole('status').textContent).toContain('旧任务已结束');
  });

  it('Abandon that the host answers with "No active agent to cancel" is not reported as done', async () => {
    await sendAndConflict('zh');
    view();
    invokeMock.mockResolvedValueOnce({ message: 'No active agent to cancel' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '放弃' })); });
    expect(screen.getByRole('status').textContent).toContain('没能结束旧任务');
  });

  it('Abandon failure is reported, not swallowed', async () => {
    await sendAndConflict('zh');
    view();
    invokeMock.mockRejectedValueOnce(new Error('boom'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '放弃' })); });
    expect(screen.getByRole('status').textContent).toContain('没能结束旧任务');
  });

  it('Retry resends with the original clientMessageId; a second rejection leaves exactly one note', async () => {
    const hook = await sendAndConflict('zh');
    useMessageActionStore.getState().register((content, context) => {
      void hook.result.current.sendMessage({ content, sessionId: SESSION_ID, ...context });
    }, () => useSessionStore.getState().messages);
    const { rerender } = view();
    rejectSendAsConflict('zh');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })); });
    await vi.waitFor(() => expect(invokeMock).toHaveBeenLastCalledWith(
      'agent:send-message', expect.objectContaining({ clientMessageId: 'u1', sessionId: SESSION_ID }),
    ));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(
      useSessionStore.getState().messages.filter((m) => m.metadata?.sendFailureCode === 'RUN_SESSION_CONFLICT'),
    ).toHaveLength(1));
    rerender(<TurnBasedTraceView projection={projectTurns(useSessionStore.getState().messages, SESSION_ID, false)} />);
    expect(screen.getAllByTestId('session-conflict-actions')).toHaveLength(1);
  });
});
