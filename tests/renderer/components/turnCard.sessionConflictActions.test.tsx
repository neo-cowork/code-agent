// @vitest-environment jsdom
// N-FIX-SEND-HANGS-WHEN-PARKED-RUN-SUPERSEDE-FAILS-FU1-FU1-FIX：409 RUN_SESSION_CONFLICT 失败说明点名的
// 说明只点名唯一的「重试」；一次点击 = agent:cancel + abandonParked（窗口内每 3 秒重复，最长约 25 秒）
// 后用原 clientMessageId 重发一次，再被拒时新说明替换旧说明（始终只有一条）。失败节点来自 useAgentIPC 真实发送失败路径。
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

async function setupRetry() {
  const hook = await sendAndConflict('zh');
  useMessageActionStore.getState().register((content, context) => {
    void hook.result.current.sendMessage({ content, sessionId: SESSION_ID, ...context });
  }, () => useSessionStore.getState().messages);
  const utils = view();
  return { ...utils };
}
const sendCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'agent:send-message');
const cancelCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'agent:cancel');
const conflictNotes = () => useSessionStore.getState().messages
  .filter((m) => m.metadata?.sendFailureCode === 'RUN_SESSION_CONFLICT');

describe('RUN_SESSION_CONFLICT failure note actions', () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each(['zh', 'en'] as const)('the note names only the single rendered Retry control (%s)', async (language) => {
    await sendAndConflict(language);
    const { container } = view();
    const note = httpFailureMessage({ status: 409, code: 'RUN_SESSION_CONFLICT', language });
    const quoted = [...note.matchAll(/[「"]([^」"]+)[」"]/g)].map((m) => m[1]);
    const labels = sessionConflictLabels[language];
    expect(quoted).toEqual([labels.retry]);
    const actions = screen.getByTestId('session-conflict-actions');
    const rendered = [...actions.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(rendered).toEqual([labels.retry]);
    expect(note).not.toMatch(/放弃|Abandon/);
    expect(actions.textContent).not.toMatch(/放弃|Abandon/);
    expect(container.textContent).toContain(note);
    expect(screen.getByTestId('user-message-edit-resend')).toBeTruthy();
  });

  it('one Retry click cancels the old run with abandonParked, then resends once with the original clientMessageId', async () => {
    await setupRetry();
    invokeMock.mockResolvedValueOnce({ message: 'Cancelled', runId: 'r1' });
    rejectSendAsConflict('zh');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })); });
    expect(cancelCalls()).toEqual([['agent:cancel', { sessionId: SESSION_ID, abandonParked: true }]]);
    await vi.waitFor(() => expect(sendCalls()).toHaveLength(2));
    expect(sendCalls()[1][1]).toEqual(expect.objectContaining({ clientMessageId: 'u1', sessionId: SESSION_ID }));
    expect(invokeMock.mock.calls.findIndex((c) => c[0] === 'agent:cancel'))
      .toBeLessThan(invokeMock.mock.calls.map((c) => c[0]).lastIndexOf('agent:send-message'));
  });

  it('window case: resends only after a later "Cancelled" reply', async () => {
    vi.useFakeTimers();
    await setupRetry();
    invokeMock
      .mockResolvedValueOnce({ message: 'No active agent to cancel' })
      .mockResolvedValueOnce({ message: 'No active agent to cancel' })
      .mockResolvedValueOnce({ message: 'Cancelled' });
    rejectSendAsConflict('zh');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })); });
    expect(cancelCalls()).toHaveLength(1);
    expect(sendCalls()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(cancelCalls()).toHaveLength(2);
    expect(sendCalls()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(cancelCalls()).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(sendCalls()).toHaveLength(2);
  });

  it('25 s without release: single resend, second 409 leaves exactly one note and no loading at 30 s', async () => {
    vi.useFakeTimers();
    const { rerender } = await setupRetry();
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'agent:cancel') return { message: 'No active agent to cancel' };
      throw Object.assign(new Error('409'), { status: 409, code: 'RUN_SESSION_CONFLICT' });
    });
    invokeDomainMock.mockRejectedValueOnce(Object.assign(
      new Error(httpFailureMessage({ status: 409, code: 'RUN_SESSION_CONFLICT', language: 'zh' })),
      { code: 'RUN_SESSION_CONFLICT' },
    ));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })); });
    expect((screen.getByRole('button', { name: '重试' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(sendCalls()).toHaveLength(2);
    expect(sendCalls()[1][1]).toEqual(expect.objectContaining({ clientMessageId: 'u1' }));
    expect(conflictNotes()).toHaveLength(1);
    rerender(<TurnBasedTraceView projection={projectTurns(useSessionStore.getState().messages, SESSION_ID, false)} />);
    expect(screen.getAllByTestId('session-conflict-actions')).toHaveLength(1);
    const button = screen.getByRole('button', { name: '重试' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(document.querySelectorAll('[data-testid="session-conflict-actions"] .animate-spin')).toHaveLength(0);
  });

  it('a thrown cancel error ends the wait with the failure line and does not resend', async () => {
    await setupRetry();
    invokeMock.mockRejectedValueOnce(new Error('boom'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })); });
    expect(screen.getByRole('status').textContent).toContain('旧任务还在收尾');
    expect(sendCalls()).toHaveLength(1);
  });
});
