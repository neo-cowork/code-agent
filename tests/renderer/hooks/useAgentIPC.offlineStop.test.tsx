// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@shared/contract';
import { recordTransportFailure, takeTransportFailure } from '../../../src/renderer/api/transportFailures';

const invokeMock = vi.hoisted(() => vi.fn());
const invokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
    invokeDomain: invokeDomainMock,
  },
}));

import { useAgentIPC } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { PendingStopNotice } from '../../../src/renderer/components/features/chat/ChatInput/PendingStopNotice';
import { SendButton } from '../../../src/renderer/components/features/chat/ChatInput/SendButton';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { usePendingStopStore } from '../../../src/renderer/stores/pendingStopStore';
import { useServerConnectionStore } from '../../../src/renderer/stores/serverConnectionStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

const SESSION_ID = 'session-offline-stop';
const STORAGE_KEY = 'neo.pendingStop.v1';

function makeUserMessage(id: string, content: string): Message {
  return {
    id,
    role: 'user',
    content,
    timestamp: Date.now(),
  };
}

function ComposerHarness({ sessionId }: { sessionId: string }) {
  const isProcessing = useAppStore((s) => s.processingSessionIds.has(sessionId));
  const isStopping = useTaskStore((s) => s.sessionStates[sessionId]?.status === 'cancelling');
  const { cancel } = useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: sessionId,
    currentTurnMessageIdRef: { current: null },
    isProcessing,
    setIsProcessing: useAppStore.getState().setIsProcessing,
    setSessionProcessing: useAppStore.getState().setSessionProcessing,
  });

  return (
    <div>
      <PendingStopNotice sessionId={sessionId} onRetryStop={() => { void cancel(); }} />
      <SendButton
        isProcessing={isProcessing}
        isStopping={isStopping}
        hasContent={false}
        onStop={() => { void cancel(); }}
      />
    </div>
  );
}

function cancelCalls() {
  return invokeMock.mock.calls.filter((call) => call[0] === 'agent:cancel');
}

describe('offline stop feedback and reconnect replay via useAgentIPC().cancel', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeDomainMock.mockReset();
    takeTransportFailure('agent:cancel');
    window.sessionStorage.clear();

    useAppStore.setState({
      language: 'zh',
      isProcessing: false,
      processingSessionIds: new Set([SESSION_ID]),
    });
    useSessionStore.setState({
      currentSessionId: SESSION_ID,
      sessions: [],
      messages: [makeUserMessage('user-turn-1', '写 36 条社区阅读角活动点子')],
      streamSnapshot: null,
      isHydratingSession: false,
      isLoading: false,
      runningSessionIds: new Set(),
    });
    useTaskStore.setState({
      sessionStates: {
        [SESSION_ID]: { status: 'running' },
      },
    });
    useServerConnectionStore.setState({
      status: 'ok',
      eventStreamRevision: 0,
      retryState: 'idle',
    });
    usePendingStopStore.setState({ entries: {} });
  });

  afterEach(() => {
    takeTransportFailure('agent:cancel');
    window.sessionStorage.clear();
  });

  it('(a) network rejection keeps status cancelling, shows pending line, and shows StoppingButton', async () => {
    invokeMock.mockImplementationOnce(async (channel: string) => {
      recordTransportFailure(channel, null, 'Failed to fetch');
      return undefined;
    });

    render(<ComposerHarness sessionId={SESSION_ID} />);
    const stopButton = screen.getByTestId('composer-stop-button');

    await act(async () => {
      fireEvent.click(stopButton);
    });

    expect(useTaskStore.getState().sessionStates[SESSION_ID]?.status).toBe('cancelling');
    expect(useAppStore.getState().isSessionProcessing(SESSION_ID)).toBe(true);
    expect(screen.getByTestId('composer-stop-stopping').textContent).toContain('正在停止');
    const notice = screen.getByTestId('pending-stop-notice');
    expect(notice.getAttribute('data-stop-state')).toBe('pending');
    expect(notice.textContent).toContain('连不上后台服务，已记下停止，恢复连接后会马上停下');
    expect(screen.queryByTestId('pending-stop-retry')).toBeNull();

    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || '{}') as Record<string, {
      sessionId: string;
      userMessageId: string | null;
      at: number;
    }>;
    expect(stored[SESSION_ID]?.sessionId).toBe(SESSION_ID);
    expect(stored[SESSION_ID]?.userMessageId).toBe('user-turn-1');
    expect(typeof stored[SESSION_ID]?.at).toBe('number');
  });

  it('(b) unmount + remount with storage kept (reload) + revision bump sends exactly one cancel then settles', async () => {
    // 1. Offline stop
    invokeMock.mockImplementationOnce(async (channel: string) => {
      recordTransportFailure(channel, null, 'Failed to fetch');
      return undefined;
    });

    const firstMount = render(<ComposerHarness sessionId={SESSION_ID} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-stop-button'));
    });
    expect(cancelCalls()).toHaveLength(1);

    // 2. Simulate reload: unmount, wipe in-memory stores while keeping sessionStorage,
    //    then hydrate session as still running on host.
    firstMount.unmount();
    invokeMock.mockReset();
    usePendingStopStore.setState({ entries: {} });
    useServerConnectionStore.setState({ status: 'ok', eventStreamRevision: 0, retryState: 'idle' });
    useTaskStore.setState({ sessionStates: { [SESSION_ID]: { status: 'running' } } });
    useAppStore.setState({ processingSessionIds: new Set([SESSION_ID]) });

    invokeMock.mockResolvedValueOnce({ message: 'Cancelled', sessionId: SESSION_ID });

    render(<ComposerHarness sessionId={SESSION_ID} />);
    // Not yet connected (eventStreamRevision === 0): no replay yet
    expect(cancelCalls()).toHaveLength(0);

    // 3. SSE connects after reload -> revision bump
    await act(async () => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });

    await waitFor(() => {
      expect(cancelCalls()).toHaveLength(1);
    });
    expect(cancelCalls()[0]).toEqual(['agent:cancel', { sessionId: SESSION_ID }]);
    expect(useTaskStore.getState().sessionStates[SESSION_ID]?.status).toBe('cancelled');
    expect(useAppStore.getState().isSessionProcessing(SESSION_ID)).toBe(false);
    expect(screen.queryByTestId('pending-stop-notice')).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('(c) replay answered 500 shows plain failure line + Retry stop, clicking it sends again', async () => {
    // Pre-populate storage as after reload
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        [SESSION_ID]: { sessionId: SESSION_ID, userMessageId: 'user-turn-1', at: Date.now() },
      }),
    );

    invokeMock
      .mockImplementationOnce(async (channel: string) => {
        recordTransportFailure(channel, 500, 'Internal Server Error: stack trace');
        return undefined;
      })
      .mockResolvedValueOnce({ message: 'Cancelled', sessionId: SESSION_ID });

    render(<ComposerHarness sessionId={SESSION_ID} />);

    await act(async () => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });

    await waitFor(() => {
      expect(screen.getByTestId('pending-stop-notice').getAttribute('data-stop-state')).toBe('failed');
    });
    const notice = screen.getByTestId('pending-stop-notice');
    expect(notice.textContent).toContain('停止没有成功');
    expect(notice.textContent).not.toContain('500');
    expect(notice.textContent).not.toContain('Internal Server Error');

    const retryButton = screen.getByTestId('pending-stop-retry');
    expect(retryButton.textContent).toContain('重试停止');

    await act(async () => {
      fireEvent.click(retryButton);
    });

    await waitFor(() => {
      expect(cancelCalls()).toHaveLength(2);
    });
    expect(useTaskStore.getState().sessionStates[SESSION_ID]?.status).toBe('cancelled');
    expect(screen.queryByTestId('pending-stop-notice')).toBeNull();
  });

  it('(d) latest user message differs after reload (newer turn) -> no cancel sent', async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        [SESSION_ID]: { sessionId: SESSION_ID, userMessageId: 'user-turn-1', at: Date.now() },
      }),
    );
    useSessionStore.setState({
      messages: [
        makeUserMessage('user-turn-1', '旧的一轮'),
        makeUserMessage('user-turn-2', '新的一轮'),
      ],
    });

    render(<ComposerHarness sessionId={SESSION_ID} />);
    await act(async () => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });

    expect(cancelCalls()).toHaveLength(0);
    expect(screen.queryByTestId('pending-stop-notice')).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('(e) online path unchanged: 200 Cancelled, 202 cancel_requested->200, and non-cancel_requested 2xx settle cleanly', async () => {
    invokeMock
      .mockResolvedValueOnce({ message: 'cancel_requested', runId: 'run-online-1', sessionId: SESSION_ID })
      .mockResolvedValueOnce({ message: 'Cancelled', runId: 'run-online-1', sessionId: SESSION_ID });

    render(<ComposerHarness sessionId={SESSION_ID} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-stop-button'));
    });

    await waitFor(() => {
      expect(useTaskStore.getState().sessionStates[SESSION_ID]?.status).toBe('cancelled');
    });
    expect(cancelCalls()).toEqual([
      ['agent:cancel', { sessionId: SESSION_ID }],
      ['agent:cancel', { runId: 'run-online-1', sessionId: SESSION_ID }],
    ]);
    expect(useAppStore.getState().isSessionProcessing(SESSION_ID)).toBe(false);
    expect(screen.queryByTestId('pending-stop-notice')).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('switches to unavailable copy + Retry stop on long outage and keeps intent when retry is still offline', async () => {
    invokeMock
      .mockImplementationOnce(async (channel: string) => {
        recordTransportFailure(channel, null, 'Failed to fetch');
        return undefined;
      })
      .mockImplementationOnce(async (channel: string) => {
        recordTransportFailure(channel, null, 'Failed to fetch');
        return undefined;
      });

    render(<ComposerHarness sessionId={SESSION_ID} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-stop-button'));
    });

    await act(async () => {
      useServerConnectionStore.getState().setStatus('unavailable');
    });

    const notice = screen.getByTestId('pending-stop-notice');
    expect(notice.getAttribute('data-stop-state')).toBe('unavailable');
    expect(notice.textContent).toContain('停止还没送到：后台服务暂时连不上');
    const retryButton = screen.getByTestId('pending-stop-retry');
    expect(retryButton.textContent).toContain('重试停止');

    await act(async () => {
      fireEvent.click(retryButton);
    });

    expect(cancelCalls()).toHaveLength(2);
    expect(useTaskStore.getState().sessionStates[SESSION_ID]?.status).toBe('cancelling');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('shows honest already-finished notice and clears storage when turn finished before reconnect', async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        [SESSION_ID]: { sessionId: SESSION_ID, userMessageId: 'user-turn-1', at: Date.now() },
      }),
    );
    useTaskStore.setState({ sessionStates: { [SESSION_ID]: { status: 'idle' } } });
    useAppStore.setState({ processingSessionIds: new Set() });

    render(<ComposerHarness sessionId={SESSION_ID} />);
    await act(async () => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });

    expect(cancelCalls()).toHaveLength(0);
    const notice = screen.getByTestId('pending-stop-notice');
    expect(notice.getAttribute('data-stop-state')).toBe('already-finished');
    expect(notice.textContent).toContain('这次回复在连接恢复前已经完成，没来得及停下');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('replays without reload on browser online event (short offline) and forwards runId when known', async () => {
    useSessionStore.setState({
      streamSnapshot: {
        sessionId: SESSION_ID,
        runId: 'run-known-42',
        turnId: 'turn-1',
        content: 'partial',
        reasoning: '',
        toolCalls: [],
        estimatedTokens: 10,
        timestamp: Date.now(),
        isFinal: false,
        streamStatus: 'incomplete',
        stableForExecution: true,
        incompleteToolCallIds: [],
      },
    });
    invokeMock
      .mockImplementationOnce(async (channel: string) => {
        recordTransportFailure(channel, null, 'Failed to fetch');
        return undefined;
      })
      .mockResolvedValueOnce({ message: 'Cancelled', runId: 'run-known-42', sessionId: SESSION_ID });

    render(<ComposerHarness sessionId={SESSION_ID} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-stop-button'));
    });
    expect(cancelCalls()).toHaveLength(1);
    expect(cancelCalls()[0]).toEqual(['agent:cancel', { sessionId: SESSION_ID, runId: 'run-known-42' }]);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(cancelCalls()).toHaveLength(2);
    });
    expect(cancelCalls()[1]).toEqual(['agent:cancel', { sessionId: SESSION_ID, runId: 'run-known-42' }]);
    expect(useTaskStore.getState().sessionStates[SESSION_ID]?.status).toBe('cancelled');
  });

  it('clears silently without already-finished notice if session already settled with user_stop', async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        [SESSION_ID]: { sessionId: SESSION_ID, userMessageId: 'user-turn-1', at: Date.now() },
      }),
    );
    useTaskStore.setState({ sessionStates: { [SESSION_ID]: { status: 'idle' } } });
    useAppStore.setState({ processingSessionIds: new Set() });
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 't',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        durableResume: {
          runId: 'run-stopped-1',
          mode: 'continue',
          interruptCause: 'user_stop',
          autoResumeCount: 0,
          maxAutoResumeCount: 3,
          canContinue: true,
        },
      }] as ReturnType<typeof useSessionStore.getState>['sessions'],
    });

    render(<ComposerHarness sessionId={SESSION_ID} />);
    await act(async () => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });

    expect(cancelCalls()).toHaveLength(0);
    expect(screen.queryByTestId('pending-stop-notice')).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('renders plain English copy in en UI', async () => {
    useAppStore.setState({ language: 'en' });
    invokeMock.mockImplementationOnce(async (channel: string) => {
      recordTransportFailure(channel, null, 'Failed to fetch');
      return undefined;
    });

    render(<ComposerHarness sessionId={SESSION_ID} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-stop-button'));
    });

    expect(screen.getByTestId('composer-stop-stopping').textContent).toContain('Stopping');
    expect(screen.getByTestId('pending-stop-notice').textContent).toContain('stop noted');

    await act(async () => {
      useServerConnectionStore.getState().setStatus('unavailable');
    });
    expect(screen.getByTestId('pending-stop-notice').textContent).toContain('temporarily unreachable');
    expect(screen.getByTestId('pending-stop-retry').textContent).toBe('Retry stop');
  });
});
