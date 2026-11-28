// ============================================================================
// Pending Stop Delivery & Replay — fail-loud cancel + 重连补发
// ============================================================================
// 1. invokeAgentCancel：调完 ipcService.invoke('agent:cancel') 后读取
//    takeTransportFailure('agent:cancel')，网络不可达（status === null）和
//    HTTP 错误（typeof status === 'number'）都不再被当成已确认取消。
// 2. deliverAgentCancel：统一执行点击停止、重连补发与「重试停止」。
// 3. usePendingStopReplay：挂载时从 sessionStorage 恢复待停止意图；每次
//    eventStreamRevision 推进（含刷新重连后首次连通）或浏览器恢复 online 时，
//    核对仍属同一轮且仍在运行再补发，防止误杀新一轮；若已在宿主侧完成则如实告知。
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import { takeTransportFailure } from '../../api/transportFailures';
import ipcService from '../../services/ipcService';
import { useAppStore } from '../../stores/appStore';
import { usePendingStopStore } from '../../stores/pendingStopStore';
import { useServerConnectionStore } from '../../stores/serverConnectionStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useTaskStore } from '../../stores/taskStore';
import { createLogger } from '../../utils/logger';
import { useSessionTurnActive } from '../useSessionTurnActive';
import {
  getLatestNonMetaUserMessageId,
  markLatestUserMessageRunCancelled,
  requestCancelUntilSettled,
  type CancelSettlementResponse,
} from './agentRuntimeFollowup';

const logger = createLogger('PendingStop');

class CancelTransportError extends Error {
  readonly status: number | null;

  constructor(status: number | null, message: string) {
    super(message || (status === null ? 'Network unavailable' : `HTTP ${status}`));
    this.name = 'CancelTransportError';
    this.status = status;
  }
}

function readErrorStatus(error: unknown): number | null {
  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

/**
 * 动作路径的 fail-loud cancel 调用：
 * httpTransport 对 fetch 拒绝（status=null）和非 2xx（status=number）静默返回 undefined
 * 并记入 transportFailures；这里取走并抛出 CancelTransportError，禁止把未送达当已确认。
 */
export async function invokeAgentCancel(
  selector?: { runId?: string; sessionId?: string },
): Promise<CancelSettlementResponse | undefined> {
  takeTransportFailure(IPC_CHANNELS.AGENT_CANCEL);
  let result: CancelSettlementResponse | undefined;
  try {
    result = await ipcService.invoke(IPC_CHANNELS.AGENT_CANCEL, selector) as CancelSettlementResponse | undefined;
  } catch (error) {
    const recorded = takeTransportFailure(IPC_CHANNELS.AGENT_CANCEL);
    const status = recorded ? recorded.status : readErrorStatus(error);
    const message = recorded?.message || (error instanceof Error ? error.message : String(error));
    throw new CancelTransportError(status, message);
  }
  if (result === undefined) {
    const failure = takeTransportFailure(IPC_CHANNELS.AGENT_CANCEL);
    if (failure) {
      throw new CancelTransportError(failure.status, failure.message);
    }
    return undefined;
  }
  takeTransportFailure(IPC_CHANNELS.AGENT_CANCEL);
  return result;
}

function resolveKnownRunId(sessionId: string, explicitRunId?: string): string | undefined {
  if (explicitRunId) return explicitRunId;
  const pendingRunId = usePendingStopStore.getState().entries[sessionId]?.runId;
  if (pendingRunId) return pendingRunId;
  const snapshot = useSessionStore.getState().streamSnapshot;
  if (snapshot?.sessionId === sessionId && !snapshot.isFinal && snapshot.runId) {
    return snapshot.runId;
  }
  return undefined;
}

export async function deliverAgentCancel(input: {
  sessionId: string;
  runId?: string;
  userMessageId?: string | null;
  setSessionProcessing: (sessionId: string, processing: boolean) => void;
}): Promise<'settled' | 'already_settled' | 'offline' | 'http_error'> {
  const { sessionId, setSessionProcessing } = input;
  const sessionStore = useSessionStore.getState();
  const userMessageId = input.userMessageId !== undefined
    ? input.userMessageId
    : getLatestNonMetaUserMessageId(sessionStore.messages);
  let knownRunId = resolveKnownRunId(sessionId, input.runId);

  const currentState = useTaskStore.getState().sessionStates[sessionId];
  useTaskStore.getState().updateSessionState(sessionId, {
    ...currentState,
    status: 'cancelling',
  });

  try {
    const confirmed = await requestCancelUntilSettled({
      sessionId,
      runId: knownRunId,
      onRunId: (runId) => {
        knownRunId = runId;
      },
      requestCancel: invokeAgentCancel,
      isCancellationActive: () => (
        useTaskStore.getState().sessionStates[sessionId]?.status === 'cancelling'
      ),
      wait: () => new Promise((resolve) => setTimeout(resolve, 250)),
    });

    usePendingStopStore.getState().clear(sessionId);
    if (confirmed) {
      markLatestUserMessageRunCancelled(Date.now(), sessionId, userMessageId);
      useTaskStore.getState().updateSessionState(sessionId, { status: 'cancelled' });
      setSessionProcessing(sessionId, false);
      if (typeof window !== 'undefined' && window.domainAPI) {
        void useSessionStore.getState().loadSessions({ silent: true });
      }
      return 'settled';
    }
    return 'already_settled';
  } catch (error) {
    if (error instanceof CancelTransportError) {
      const intent = {
        sessionId,
        userMessageId,
        ...(knownRunId ? { runId: knownRunId } : {}),
        at: Date.now(),
      };
      if (error.status === null) {
        // 离线/网络层拒收：保持 cancelling 态与 pending 意图，连上后自动补发。
        const currentRevision = useServerConnectionStore.getState().eventStreamRevision;
        usePendingStopStore.getState().recordPending(intent, currentRevision);
        logger.info('Queued stop while offline', {
          sessionId,
          runId: knownRunId ?? null,
          userMessageId,
        });
        return 'offline';
      }
      // HTTP 非 2xx：明确展示失败行 + 「重试停止」，不得谎报已取消。
      usePendingStopStore.getState().markFailed(intent);
      if (useAppStore.getState().isSessionProcessing(sessionId)) {
        useTaskStore.getState().updateSessionState(sessionId, { status: 'running' });
      }
      logger.warn('Cancel request failed with HTTP status', {
        sessionId,
        status: error.status,
      });
      return 'http_error';
    }
    throw error;
  }
}

export function usePendingStopReplay(input: {
  currentSessionId: string | null;
  setSessionProcessing: (sessionId: string, processing: boolean) => void;
}): void {
  const { currentSessionId, setSessionProcessing } = input;
  const entry = usePendingStopStore((state) => (
    currentSessionId ? state.entries[currentSessionId] : undefined
  ));
  const eventStreamRevision = useServerConnectionStore((state) => state.eventStreamRevision);
  const serverStatus = useServerConnectionStore((state) => state.status);
  const messages = useSessionStore((state) => state.messages);
  const isHydratingSession = useSessionStore((state) => state.isHydratingSession);
  const isLoading = useSessionStore((state) => state.isLoading);
  const isTurnActive = useSessionTurnActive(currentSessionId);
  const taskStatus = useTaskStore((state) => (
    currentSessionId ? state.sessionStates[currentSessionId]?.status : undefined
  ));
  const durableInterruptCause = useSessionStore((state) => (
    currentSessionId
      ? state.sessions.find((session) => session.id === currentSessionId)?.durableResume?.interruptCause
      : undefined
  ));

  const [onlineTick, setOnlineTick] = useState(0);
  const inFlightRef = useRef(false);
  const lastTriggerKeyRef = useRef<string | null>(null);
  const lastConsumedOnlineTickRef = useRef(0);

  // 挂载时从 sessionStorage 同步待补发停止（刷新后或重新挂载都能接上）。
  useEffect(() => {
    usePendingStopStore.getState().hydrateFromStorage();
  }, []);

  // 短暂断网（未达横幅阈值、status 仍为 ok、不刷新页面）恢复时，浏览器派发 online 立即补发；
  // 横幅已出现（recovering / unavailable）时监视器会在恢复探测后整页 reload，留给刷新后补发，
  // 避免抢在卸载前发出的 /api/cancel 被导航掐断。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOnline = () => {
      if (useServerConnectionStore.getState().status !== 'ok') return;
      setOnlineTick((tick) => tick + 1);
    };
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  // 核对轮次绑定：新一轮已开始 → 静默清空不误杀；同一轮已在宿主侧完成 → 如实提示并清存储。
  useEffect(() => {
    if (!currentSessionId || !entry) return;
    if (isHydratingSession || isLoading) return;
    if (entry.userMessageId !== null && messages.length === 0) return;

    const latestUserMessageId = getLatestNonMetaUserMessageId(messages);
    if (entry.userMessageId !== null && latestUserMessageId !== entry.userMessageId) {
      usePendingStopStore.getState().clear(currentSessionId);
      return;
    }

    if (entry.phase !== 'pending') return;
    if (taskStatus === 'cancelled' || durableInterruptCause === 'user_stop') {
      usePendingStopStore.getState().clear(currentSessionId);
      return;
    }
    if (!isTurnActive) {
      usePendingStopStore.getState().markAlreadyFinished(currentSessionId);
    }
  }, [currentSessionId, durableInterruptCause, entry, isHydratingSession, isLoading, isTurnActive, messages, taskStatus]);

  // 连接恢复（eventStreamRevision 推进、刷新后首次连通、或浏览器 online）时自动补发一次停止。
  useEffect(() => {
    if (!currentSessionId || entry?.phase !== 'pending') return;
    if (isHydratingSession || isLoading) return;
    if (entry.userMessageId !== null && messages.length === 0) return;
    if (entry.userMessageId !== null && getLatestNonMetaUserMessageId(messages) !== entry.userMessageId) {
      return;
    }
    if (!isTurnActive || taskStatus === 'cancelled') return;
    if (serverStatus !== 'ok') return;

    const rehydrated = entry.recordedAtRevision === null;
    const streamConnectedAfterReload = rehydrated && eventStreamRevision > 0;
    const streamAdvanced = entry.recordedAtRevision !== null && eventStreamRevision > entry.recordedAtRevision;
    const cameBackOnline = onlineTick > lastConsumedOnlineTickRef.current;

    if (!streamConnectedAfterReload && !streamAdvanced && !cameBackOnline) {
      return;
    }

    const triggerKey = `${entry.sessionId}:${entry.at}:${eventStreamRevision}:${onlineTick}`;
    if (inFlightRef.current || lastTriggerKeyRef.current === triggerKey) return;

    lastTriggerKeyRef.current = triggerKey;
    lastConsumedOnlineTickRef.current = onlineTick;
    inFlightRef.current = true;

    const trigger = streamConnectedAfterReload
      ? 'reload'
      : streamAdvanced
        ? 'event_stream'
        : 'online';
    const selectorKind = entry.runId ? 'runId' : 'sessionId';
    logger.info('Replaying queued stop after reconnect', {
      sessionId: entry.sessionId,
      runId: entry.runId ?? null,
      selector: selectorKind,
      userMessageId: entry.userMessageId,
      trigger,
    });

    void deliverAgentCancel({
      sessionId: entry.sessionId,
      runId: entry.runId,
      userMessageId: entry.userMessageId,
      setSessionProcessing,
    }).finally(() => {
      inFlightRef.current = false;
    });
  }, [
    currentSessionId,
    entry,
    eventStreamRevision,
    isHydratingSession,
    isLoading,
    isTurnActive,
    messages,
    onlineTick,
    serverStatus,
    setSessionProcessing,
    taskStatus,
  ]);
}
