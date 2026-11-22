// @vitest-environment jsdom
// N-STOP-ABANDON-ENTRY：停靠（user_stop 等）待「继续」的 run 的「放弃」入口。
// N-FIX-STEP-HEADER-AND-STOPPED-ROW-REPEAT 起「放弃」并入输入框里「继续」同一处，停靠行只说原因不带按钮。
// 这里钉的是渲染层契约：行何时出现、模态先于 IPC、确认才终态化、投影翻终态后行消失。
// 装配方式镜像 ChatView 的接线（同 durableResume.continueState.test.tsx 的 ParkedComposer 先例），
// composer 核心键（Stop/Continue）不在本单改动面，⑤ 只钉「没多出新的 composer 按钮」。
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, StreamRecoverySnapshot } from '../../../src/shared/contract';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const ipcInvoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/renderer/services/ipcService', () => {
  const ipcService = { invoke: ipcInvoke, invokeDomain: vi.fn(async () => undefined), on: () => () => undefined };
  return { default: ipcService, ipcService, invoke: ipcInvoke };
});
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: toastError },
}));

import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useI18n } from '../../../src/renderer/hooks/useI18n';
import {
  DurableParkedNotice,
  DurableResumeNotice,
  shouldShowParkedNotice,
  suppressLegacyInterruptionDecision,
  useAbandonParkedRun,
  useDurableContinueVisible,
} from '../../../src/renderer/components/features/chat/durableResume';
import { SendButton } from '../../../src/renderer/components/features/chat/ChatInput/SendButton';
import { DecisionSlot } from '../../../src/renderer/components/features/chat/DecisionSlot';
import { deriveRetryTurnMessage } from '../../../src/renderer/components/ChatView';
import { deriveStreamInterruptionDecision } from '../../../src/renderer/utils/streamInterruptionDecision';
import { buildSidebarProjectSummary } from '../../../src/renderer/utils/sidebarProjectSummary';

const SESSION_ID = 'session-parked';
const PARKED = { mode: 'continue', canContinue: true, runId: 'run-parked-1' };
// 真跑（Rework r1）撞出的缺陷复现要用真 loadSessions（executeLoadSessions +
// preserveParkedContinueOnRefresh），在首个用例覆写前抓原始引用。
const realLoadSessions = useSessionStore.getState().loadSessions;

// 与 ChatView 相同的接线：mode 行 + 停靠原因行（无按钮）+ confirmDialog + composer（继续/放弃同处）。
function ParkedRow({ resume, turnActive }: {
  resume: { mode: string; canContinue: boolean; runId?: string; quotaWait?: unknown } | undefined;
  turnActive: boolean;
}) {
  const { t } = useI18n();
  const show = useDurableContinueVisible(resume, turnActive);
  const showRow = shouldShowParkedNotice(resume, turnActive);
  const abandon = useAbandonParkedRun(SESSION_ID, resume?.runId);
  return (
    <>
      {resume?.mode === 'auto-resuming' && <DurableResumeNotice text={t.chat.durableResumeNotice} />}
      {resume?.mode === 'queued' && <DurableResumeNotice text={t.chat.durableResumeQueuedNotice} />}
      {showRow && <DurableParkedNotice />}
      {abandon.confirmDialog}
      <SendButton hasContinuation={show} isProcessing={turnActive} onContinue={() => undefined} onAbandon={abandon.onAbandon} onStop={() => undefined} />
    </>
  );
}

const ROW = 'durable-stopped-notice';

function dialogConfirmButton(): HTMLElement {
  const dialog = screen.getByRole('dialog');
  return screen.getAllByRole('button', { name: /^(放弃|Abandon)$/ })
    .find((button) => dialog.contains(button))!;
}

describe('abandon entry in the durable resume notice row', () => {
  it('quota_wait park (continue+canContinue+quotaWait) shows no stopped row / abandon button', () => {
    const { rerender } = render(<ParkedRow resume={PARKED} turnActive={false} />);
    expect(screen.getByTestId(ROW)).toBeTruthy();
    rerender(<ParkedRow resume={{ ...PARKED, quotaWait: { dueAt: 1, duePassed: false } }} turnActive={false} />);
    expect(screen.queryByTestId(ROW)).toBeNull();
  });

  let loadSessions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    loadSessions = vi.fn(async () => undefined);
    useSessionStore.setState({ loadSessions } as never);
    ipcInvoke.mockReset().mockResolvedValue(undefined);
    toastError.mockClear();
  });

  it('① parked row carries the abandon button only for idle continue+canContinue; other modes show no abandon; active turn / not continuable hide the row', () => {
    const { rerender } = render(<ParkedRow resume={PARKED} turnActive={false} />);
    expect(screen.getAllByTestId(ROW)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^(放弃|Abandon)$/ })).toBeTruthy();

    rerender(<ParkedRow resume={{ mode: 'auto-resuming', canContinue: false }} turnActive={false} />);
    expect(screen.getAllByTestId('durable-resume-notice')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^(放弃|Abandon)$/ })).toBeNull();

    rerender(<ParkedRow resume={{ mode: 'queued', canContinue: false }} turnActive={false} />);
    expect(screen.getAllByTestId('durable-resume-notice')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^(放弃|Abandon)$/ })).toBeNull();

    // 活跃轮（Stop 显示中）：停靠行整行不出现
    rerender(<ParkedRow resume={PARKED} turnActive={true} />);
    expect(screen.queryByTestId(ROW)).toBeNull();
    expect(screen.queryByRole('button', { name: /^(放弃|Abandon)$/ })).toBeNull();

    // canContinue=false：同样不出现
    rerender(<ParkedRow resume={{ mode: 'continue', canContinue: false, runId: 'run-parked-1' }} turnActive={false} />);
    expect(screen.queryByTestId(ROW)).toBeNull();
  });

  it('② abandon opens the danger modal and no cancel IPC fires; dialog Cancel closes it, still no IPC', () => {
    render(<ParkedRow resume={PARKED} turnActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^(放弃|Abandon)$/ }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/放弃这个已停止的任务|Abandon this stopped task/);
    // danger 变体：confirm 钮走 BUTTON_DANGER_CLASS（红底），不是 primary/warning
    expect(dialogConfirmButton().className).toContain('bg-red-600');
    expect(ipcInvoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^(取消|Cancel)$/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(ipcInvoke).not.toHaveBeenCalled();
  });

  it('③ confirm cancels exactly once with sessionId+runId then refreshes sessions; a rejected IPC toasts and the row stays', async () => {
    const { rerender } = render(<ParkedRow resume={PARKED} turnActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^(放弃|Abandon)$/ }));
    fireEvent.click(dialogConfirmButton());

    await waitFor(() => expect(ipcInvoke).toHaveBeenCalledTimes(1));
    // abandonParked 显式区分「放弃」与重复 Stop（后者对 user_stop 停靠是 no-op）。
    expect(ipcInvoke).toHaveBeenCalledWith('agent:cancel', { sessionId: SESSION_ID, runId: 'run-parked-1', abandonParked: true });
    await waitFor(() => expect(loadSessions).toHaveBeenCalledWith({ silent: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId(ROW)).toBeTruthy();

    // IPC 拒绝：toast.error 带原始 message，停靠行不动（投影没翻终态）
    ipcInvoke.mockRejectedValueOnce(new Error('cancel route down'));
    rerender(<ParkedRow resume={PARKED} turnActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^(放弃|Abandon)$/ }));
    fireEvent.click(dialogConfirmButton());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('cancel route down'));
    expect(screen.getByTestId(ROW)).toBeTruthy();
  });

  it('④ once the refreshed projection has no durableResume the row and abandon button disappear', () => {
    const { rerender } = render(<ParkedRow resume={PARKED} turnActive={false} />);
    expect(screen.getByTestId(ROW)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^(放弃|Abandon)$/ })).toBeTruthy();

    rerender(<ParkedRow resume={undefined} turnActive={false} />);
    expect(screen.queryByTestId(ROW)).toBeNull();
    expect(screen.queryByRole('button', { name: /^(放弃|Abandon)$/ })).toBeNull();
  });

  it('⑤ one action entry: Continue and Abandon live together in the composer, the parked row has no buttons; active turn renders Stop only', () => {
    const { rerender } = render(<ParkedRow resume={PARKED} turnActive={false} />);
    const control = screen.getByTestId('continue-run-control');
    expect(screen.getAllByTestId('continue-run-control')).toHaveLength(1);
    expect(within(control).getByTestId('continue-run-button')).toBeTruthy();
    expect(within(control).getByRole('button', { name: /^(放弃|Abandon)$/ })).toBeTruthy();
    expect(within(screen.getByTestId(ROW)).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: /^(放弃|Abandon)$/ })).toHaveLength(1);

    rerender(<ParkedRow resume={PARKED} turnActive={true} />);
    expect(screen.queryByTestId('continue-run-button')).toBeNull();
    expect(screen.getByRole('button', { name: /^(停止|Stop)$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(放弃|Abandon)$/ })).toBeNull();
  });
});

// Rework r1：真跑暴露「确认放弃后停靠行不消失」。链路：run 已被 /api/cancel 终态化
// （服务端投影已无 durableResume），但会话行 updatedAt 不动，loadSessions 的防陈旧
// 快照守卫 preserveParkedContinueOnRefresh 把「可继续」投影原样复活 → 行永远在，
// 只能整页重载才消。这里用真 loadSessions + 真 store 复刻该形状。
describe('abandon clears the parked projection against the stale-guarded session refresh', () => {
  const UPDATED_AT = 1_000;
  const session = { id: SESSION_ID, title: 't', updatedAt: UPDATED_AT, createdAt: UPDATED_AT, status: 'interrupted' };
  const message: Message = { id: 'user-turn', role: 'user', content: 'Draft a library event guide', timestamp: UPDATED_AT };
  const snapshot: StreamRecoverySnapshot = {
    sessionId: SESSION_ID, runId: PARKED.runId, turnId: 'assistant-turn', content: 'Partial reply',
    reasoning: '', toolCalls: [], estimatedTokens: 2, timestamp: UPDATED_AT + 1,
    isFinal: false, streamStatus: 'incomplete', stableForExecution: false, incompleteToolCallIds: [],
  };
  function unfinishedCount(): number {
    return buildSidebarProjectSummary({
      group: {
        key: 'library',
        name: 'Library',
        paths: [],
        isUncategorized: false,
        sessions: useSessionStore.getState().sessions,
        latestActivityAt: UPDATED_AT,
      },
      backgroundSessionMap: new Map(),
      sessionRuntimes: new Map(),
      sessionStates: {},
    }).unfinishedCount;
  }
  function StoreDrivenRow({ turnActive }: { turnActive: boolean }) {
    const resume = useSessionStore((state) => state.sessions.find((session) => session.id === SESSION_ID)?.durableResume);
    const streamSnapshot = useSessionStore((state) => state.streamSnapshot);
    const messages = useSessionStore((state) => state.messages);
    const show = useDurableContinueVisible(resume, turnActive);
    const abandon = useAbandonParkedRun(SESSION_ID, resume?.runId);
    const decision = deriveStreamInterruptionDecision(
      streamSnapshot, deriveRetryTurnMessage(streamSnapshot, messages), turnActive, messages,
    );
    return (
      <>
        {show && <DurableParkedNotice interruptCause={resume?.interruptCause} />}
        <DecisionSlot streamInterruption={suppressLegacyInterruptionDecision(
          decision && { ...decision, onContinue: async () => false }, resume?.mode,
        )} />
        <SendButton hasContinuation={show} onContinue={() => undefined} onAbandon={abandon.onAbandon} />
        {abandon.confirmDialog}
      </>
    );
  }

  beforeEach(() => {
    ipcInvoke.mockReset().mockResolvedValue(undefined);
    toastError.mockClear();
    useSessionStore.setState({
      currentSessionId: SESSION_ID,
      loadSessions: realLoadSessions,
      streamSnapshot: snapshot,
      messages: [message],
      // 停靠会话行：mode continue + canContinue（与 ChatView 从 sessions.find 取的投影同源）
      sessions: [{
        ...session,
        durableResume: { runId: 'run-parked-1', mode: 'continue', interruptCause: 'user_stop', autoResumeCount: 0, maxAutoResumeCount: 3, canContinue: true },
      }] as never,
    });
    // 服务端真跑形状：run 已终态化 → 刷新回的同一行没有 durableResume、updatedAt 没动
    window.domainAPI = {
      invoke: vi.fn(async () => ({
        success: true,
        data: [session],
      })),
    } as never;
  });

  it('confirmed abandon removes the stopped row and decision through list refresh and forced session reload', async () => {
    const cancelled = { ...session, status: 'cancelled', messageCount: 1, turnCount: 1 };
    const hostInvoke = vi.fn(async (_domain: string, action: string) => ({
      success: true,
      data: action === 'load' ? { ...cancelled, messages: [message] } : action === 'list' ? [cancelled] : [],
    }));
    window.domainAPI = { invoke: hostInvoke } as never;
    render(<StoreDrivenRow turnActive={false} />);
    expect(screen.getByTestId(ROW)).toBeTruthy();
    expect(screen.queryByTestId('stream-interruption-decision')).toBeNull();
    expect(unfinishedCount()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '放弃' }));

    await waitFor(() => {
      expect(screen.queryByTestId(ROW)).toBeNull();
      expect(useSessionStore.getState().streamSnapshot).toBeNull();
      expect(unfinishedCount()).toBe(0);
    }, { timeout: 2_000 });
    expect(hostInvoke).toHaveBeenCalledWith(IPC_DOMAINS.SESSION, 'list', expect.anything());
    expect(screen.queryByTestId('stream-interruption-decision')).toBeNull();
    expect(useSessionStore.getState().sessions.find((session) => session.id === SESSION_ID)?.durableResume).toBeUndefined();

    await act(() => useSessionStore.getState().switchSession(SESSION_ID, { force: true }));
    expect(hostInvoke).toHaveBeenCalledWith(IPC_DOMAINS.SESSION, 'load', { sessionId: SESSION_ID });
    expect(useSessionStore.getState().streamSnapshot).toBeNull();
    expect(screen.queryByTestId('stream-interruption-decision')).toBeNull();
    expect(unfinishedCount()).toBe(0);
  });

  it('ignores a session load that read the snapshot before abandon settled', async () => {
    const stale = { ...session, messages: [message], streamSnapshot: snapshot };
    let releaseStaleLoad!: () => void;
    let loads = 0;
    window.domainAPI = {
      invoke: vi.fn(async (_domain: string, action: string) => {
        if (action === 'load' && ++loads === 1) {
          return new Promise((resolve) => {
            releaseStaleLoad = () => resolve({ success: true, data: stale });
          });
        }
        return { success: true, data: action === 'load' ? { ...session, messages: [message] } : action === 'list' ? [session] : [] };
      }),
    } as never;
    let staleLoad!: Promise<void>;
    render(<StoreDrivenRow turnActive={false} />);
    act(() => { staleLoad = useSessionStore.getState().switchSession(SESSION_ID, { force: true }); });
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(dialogConfirmButton());
    await waitFor(() => expect(loads).toBe(2));
    await act(async () => {
      releaseStaleLoad();
      await staleLoad;
    });
    expect(useSessionStore.getState().streamSnapshot).toBeNull();
    expect(screen.queryByTestId('stream-interruption-decision')).toBeNull();
  });

  it('preserves a newer run projection and snapshot when the abandon response arrives late', async () => {
    let confirmAbandon!: () => void;
    ipcInvoke.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      confirmAbandon = () => resolve(undefined);
    }));
    render(<StoreDrivenRow turnActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(dialogConfirmButton());

    const newer = { ...snapshot, runId: 'run-newer' };
    await act(async () => {
      useSessionStore.setState((state) => ({
        streamSnapshot: newer,
        sessions: state.sessions.map((item) => ({
          ...item, durableResume: item.durableResume && { ...item.durableResume, runId: newer.runId },
        })),
      }));
      confirmAbandon();
    });
    expect(useSessionStore.getState().streamSnapshot).toEqual(newer);
    expect(useSessionStore.getState().sessions[0].durableResume?.runId).toBe(newer.runId);
  });

  afterEach(() => {
    delete window.domainAPI;
  });
});
