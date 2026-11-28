// ============================================================================
// OfflinePendingSendNotice — Surface A 离线挂起提示条 + 草稿提示协调容器
// ============================================================================
// 紧邻 UnsentDraftNotice 的槽位：离线挂起/重放/失败期间渲染独立提示条并抑制通用草稿卡。
// ============================================================================

import React from 'react';
import { Loader2, WifiOff } from 'lucide-react';
import { Button } from '../../../primitives/Button';
import { useI18n } from '../../../../hooks/useI18n';
import { UnsentDraftNotice } from './UnsentDraftNotice';
import type { OfflinePendingSendStatus } from './useOfflinePendingSend';

interface DraftNoticeView {
  preview: string;
  attachmentNames: string[];
  droppedNames: string[];
}

function OfflinePendingSendStrip({
  status,
  onCancelAutoSend,
}: {
  status: Exclude<OfflinePendingSendStatus, 'idle'>;
  onCancelAutoSend: () => void;
}): React.ReactElement {
  const { t } = useI18n();
  const message =
    status === 'sending'
      ? t.chatInput.offlineSendReplaying
      : status === 'replay_failed'
        ? t.chatInput.offlineSendReplayFailed
        : status === 'attachments_not_sent'
          ? t.chatInput.offlineSendAttachmentsNotSent
          : t.chatInput.offlineSendWaiting;

  return (
    <div
      role="status"
      data-testid="offline-pending-send-notice"
      data-offline-send-state={status}
      className="mb-2 flex items-center gap-2 rounded-xl border border-border-default bg-surface-subtle px-3 py-2"
    >
      {status === 'sending' ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-secondary" aria-hidden="true" />
      ) : (
        <WifiOff className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
      )}
      <p className="min-w-0 flex-1 break-words text-sm text-text-primary">{message}</p>
      {status === 'waiting' && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="offline-send-cancel-auto"
          onClick={onCancelAutoSend}
        >
          {t.chatInput.offlineSendCancelAuto}
        </Button>
      )}
    </div>
  );
}

/** 统一承载离线挂起条与通用未发送草稿条：有离线挂起或独立提示时抑制通用草稿卡。 */
export function ComposerDraftNotices({
  visible,
  offlineStatus,
  suppressGenericDraftNotice,
  onCancelAutoSend,
  draftNotice,
  onPutBackDraft,
  onDiscardDraft,
}: {
  visible: boolean;
  offlineStatus: OfflinePendingSendStatus;
  suppressGenericDraftNotice: boolean;
  onCancelAutoSend: () => void;
  draftNotice: DraftNoticeView | null;
  onPutBackDraft: () => void;
  onDiscardDraft: () => void;
}): React.ReactElement | null {
  if (!visible) return null;
  if (offlineStatus !== 'idle') {
    return (
      <OfflinePendingSendStrip
        status={offlineStatus}
        onCancelAutoSend={onCancelAutoSend}
      />
    );
  }
  if (!draftNotice || suppressGenericDraftNotice) return null;
  return (
    <UnsentDraftNotice
      preview={draftNotice.preview}
      attachmentNames={draftNotice.attachmentNames}
      droppedNames={draftNotice.droppedNames}
      onPutBack={onPutBackDraft}
      onDiscard={onDiscardDraft}
    />
  );
}
