// ============================================================================
// useOfflineOutboxReplay — Surface B 离线失败气泡自动重放
// ============================================================================
// 在事件流重新连上（eventStreamRevision 推进，或刷新后挂载可达）时，
// 先按 clientMessageId 对账恢复后的历史消息，再复用卡片既有重试锚点
// （useMessageActionStore.regenerateMessage）自动发一次。
// ============================================================================

import { useEffect, useRef } from 'react';
import { clearFailedSend, recordFailedSend } from '../../stores/failedSendOutbox';
import { useMessageActionStore } from '../../stores/messageActionStore';
import { useServerConnectionStore } from '../../stores/serverConnectionStore';
import { useSessionStore } from '../../stores/sessionStore';
import { createLogger } from '../../utils/logger';
import {
  clearOfflineOutboxAutoSendTicket,
  clearOfflineOutboxFailureRevision,
  finishOfflineAutoReplayAttempt,
  getOfflineOutboxFailureRevision,
  isOfflineAutoReplayingId,
  isOfflineOutboxAutoSendEligible,
  markOfflineAutoReplayAttempt,
  OFFLINE_SEND_FAILED_CODE,
  OFFLINE_SEND_PENDING_CODE,
} from '../../utils/offlineSend';

const logger = createLogger('OfflineSendReplay');

export function useOfflineOutboxReplay(params: {
  currentSessionId: string | null;
  effectiveIsProcessing: boolean;
}): void {
  const { currentSessionId, effectiveIsProcessing } = params;
  const messages = useSessionStore((state) => state.messages);
  const isHydratingSession = useSessionStore((state) => state.isHydratingSession);
  const isLoading = useSessionStore((state) => state.isLoading);
  const eventStreamRevision = useServerConnectionStore((state) => state.eventStreamRevision);
  const serverStatus = useServerConnectionStore((state) => state.status);
  const hasRegisteredSender = useMessageActionStore((state) => state._send !== null);
  const attemptedErrorIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!currentSessionId || effectiveIsProcessing || isHydratingSession || isLoading) return;
    if (!hasRegisteredSender || !Array.isArray(messages) || messages.length === 0) return;

    const pendingError = messages.find((message) => {
      if (message.role !== 'assistant') return false;
      if (message.metadata?.sendFailureCode !== OFFLINE_SEND_PENDING_CODE) return false;
      const anchorSession = message.metadata?.retrySessionId;
      if (typeof anchorSession === 'string' && anchorSession !== currentSessionId) return false;
      return typeof message.metadata?.retryClientMessageId === 'string';
    });
    if (!pendingError) return;

    const clientMessageId = pendingError.metadata?.retryClientMessageId;
    if (!clientMessageId) return;

    // 1. 先按 clientMessageId 对账恢复后的历史消息：已存在且非失败态 → 清出 outbox 与旧提示卡，绝不重发。
    const confirmedInHistory = messages.some(
      (message) => message.role === 'user' && message.id === clientMessageId && message.metadata?.sendFailed !== true,
    );
    if (confirmedInHistory) {
      logger.info('Surface B replay skipped: clientMessageId already in restored history', {
        sessionId: currentSessionId,
        clientMessageId,
      });
      clearFailedSend(currentSessionId, clientMessageId);
      clearOfflineOutboxFailureRevision(currentSessionId, clientMessageId);
      clearOfflineOutboxAutoSendTicket(currentSessionId, clientMessageId);
      const live = useSessionStore.getState();
      if (live.currentSessionId === currentSessionId) {
        live.setMessages(live.messages.filter((message) => message.id !== pendingError.id));
      }
      return;
    }

    // 2. 非浏览器明确 offline；同页未刷新须等 eventStreamRevision 推进（SSE onopen 本身即证明可达，
    //    不与 /api/health 轮询竞态）；刷新后新堆无记录，挂载且 status === 'ok' 且事件流已连上即触发。
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (eventStreamRevision < 1) return;

    const recordedRevision = getOfflineOutboxFailureRevision(currentSessionId, clientMessageId);
    if (recordedRevision !== undefined) {
      if (eventStreamRevision <= recordedRevision) return;
    } else if (serverStatus !== 'ok') {
      return;
    }

    // 3. 标签页时效守卫：只对本标签页且未过 TTL 的挂起记录自动重放；
    //    关闭重开或过期后在连接恢复/重新打开时降级为常规手动重试态，绝不静默执行旧指令。
    if (!isOfflineOutboxAutoSendEligible(currentSessionId, clientMessageId)) {
      clearOfflineOutboxFailureRevision(currentSessionId, clientMessageId);
      const downgradedError = {
        ...pendingError,
        metadata: { ...pendingError.metadata, sendFailureCode: OFFLINE_SEND_FAILED_CODE },
      };
      const live = useSessionStore.getState();
      const failedUser = live.messages.find((message) => message.role === 'user' && message.id === clientMessageId);
      if (failedUser) {
        recordFailedSend(currentSessionId, failedUser, downgradedError);
      }
      if (live.currentSessionId === currentSessionId) {
        live.setMessages(live.messages.map((message) => (message.id === pendingError.id ? downgradedError : message)));
      }
      return;
    }
    if (isOfflineAutoReplayingId(clientMessageId) || attemptedErrorIdsRef.current.has(pendingError.id)) return;

    attemptedErrorIdsRef.current.add(pendingError.id);
    clearOfflineOutboxFailureRevision(currentSessionId, clientMessageId);
    clearOfflineOutboxAutoSendTicket(currentSessionId, clientMessageId);
    markOfflineAutoReplayAttempt(clientMessageId, 'outbox');
    logger.info('Surface B replaying offline failed bubble', {
      sessionId: currentSessionId,
      clientMessageId,
      eventStreamRevision,
    });

    const dispatched = useMessageActionStore.getState().regenerateMessage(pendingError.id);
    if (dispatched) {
      clearFailedSend(currentSessionId, clientMessageId);
      const live = useSessionStore.getState();
      if (live.currentSessionId === currentSessionId) {
        live.setMessages(live.messages.filter((message) => message.id !== pendingError.id));
      }
    } else {
      finishOfflineAutoReplayAttempt(clientMessageId);
    }
  }, [
    currentSessionId,
    effectiveIsProcessing,
    eventStreamRevision,
    hasRegisteredSender,
    isHydratingSession,
    isLoading,
    messages,
    serverStatus,
  ]);
}
