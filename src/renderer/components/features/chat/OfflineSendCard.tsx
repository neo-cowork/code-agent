// ============================================================================
// OfflineSendCard — Surface B 失败气泡的离线等待 / 重试卡片
// ============================================================================
// 对应 SEND_OFFLINE_PENDING（断线等待自动重发）与 SEND_OFFLINE_FAILED（自动重放失败后
// 回到常规重试态）。复用卡片既有的 regenerateMessage 重试锚点（原 clientMessageId）。
// ============================================================================

import React, { useCallback, useSyncExternalStore } from 'react';
import { Loader2, WifiOff } from 'lucide-react';
import type { TraceNode } from '@shared/contract/trace';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { clearFailedSend } from '../../../stores/failedSendOutbox';
import { useMessageActionStore } from '../../../stores/messageActionStore';
import { useSessionStore } from '../../../stores/sessionStore';
import {
  clearOfflineOutboxAutoSendTicket,
  clearOfflineOutboxFailureRevision,
  isOfflineAutoReplayingId,
  OFFLINE_SEND_PENDING_CODE,
  subscribeOfflineAutoReplaying,
} from '../../../utils/offlineSend';

export function OfflineSendCard({
  node,
  sessionId,
}: {
  node: TraceNode;
  sessionId?: string;
}): React.ReactElement {
  const { t } = useI18n();
  const messageId = node.messageId || (node.id.endsWith('-text') ? node.id.slice(0, -5) : node.id);
  const anchorSessionId = typeof node.metadata?.retrySessionId === 'string'
    ? node.metadata.retrySessionId
    : sessionId;
  const retryClientMessageId = typeof node.metadata?.retryClientMessageId === 'string'
    ? node.metadata.retryClientMessageId
    : undefined;
  const isPending = node.metadata?.sendFailureCode === OFFLINE_SEND_PENDING_CODE;

  const isReplaying = useSyncExternalStore(
    subscribeOfflineAutoReplaying,
    () => isOfflineAutoReplayingId(retryClientMessageId),
    () => false,
  );
  const isRunning = useSessionStore((state) => (
    anchorSessionId ? state.runningSessionIds.has(anchorSessionId) : false
  ));

  const handleRetry = useCallback(() => {
    if (anchorSessionId && retryClientMessageId) {
      clearOfflineOutboxFailureRevision(anchorSessionId, retryClientMessageId);
      clearOfflineOutboxAutoSendTicket(anchorSessionId, retryClientMessageId);
    }
    const resent = useMessageActionStore.getState().regenerateMessage(messageId);
    if (!resent) return;
    const sessions = useSessionStore.getState();
    if (anchorSessionId && retryClientMessageId) {
      clearFailedSend(anchorSessionId, retryClientMessageId);
    }
    if (!anchorSessionId || sessions.currentSessionId === anchorSessionId) {
      sessions.setMessages(sessions.messages.filter((message) => message.id !== messageId));
    }
  }, [anchorSessionId, messageId, retryClientMessageId]);

  const cardState = isPending ? (isReplaying ? 'sending' : 'waiting') : 'failed';
  const copy =
    cardState === 'sending'
      ? t.chatInput.offlineSendReplaying
      : cardState === 'waiting'
        ? t.chatInput.offlineSendWaiting
        : t.chatInput.offlineSendRetryFailedCard;

  return (
    <div
      role="status"
      data-testid="offline-send-card"
      data-offline-card-state={cardState}
      className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border-default bg-surface-subtle px-3 py-2"
    >
      {cardState === 'sending' ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-secondary" aria-hidden="true" />
      ) : (
        <WifiOff className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 text-sm text-text-primary">{copy}</span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        data-testid="offline-send-retry"
        disabled={isReplaying || isRunning}
        onClick={handleRetry}
      >
        {t.agentError.actions.retry}
      </Button>
    </div>
  );
}
