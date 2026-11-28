import React from 'react';
import { Button } from '../../../primitives/Button';
import { useI18n } from '../../../../hooks/useI18n';
import { usePendingStopStore } from '../../../../stores/pendingStopStore';
import { useServerConnectionStore } from '../../../../stores/serverConnectionStore';

interface PendingStopNoticeProps {
  sessionId: string | null;
  onRetryStop?: () => void;
}

/**
 * 离线期间点击停止的反馈行（输入框正上方）：
 * - 离线待补发：说明已记下、连上立刻停
 * - 长时间断连（unavailable）：提示还没送到 + 「重试停止」
 * - 补发/请求收到 HTTP 错误：一句人话失败提示 + 「重试停止」，不露原始错误
 * - 恢复前任务已在宿主侧完成：如实说明没来得及停下
 */
export function PendingStopNotice({
  sessionId,
  onRetryStop,
}: PendingStopNoticeProps): React.ReactElement | null {
  const { t } = useI18n();
  const entry = usePendingStopStore((state) => (sessionId ? state.entries[sessionId] : undefined));
  const connectionStatus = useServerConnectionStore((state) => state.status);

  if (!entry) return null;

  const text = t.serverConnection;
  let message: string;
  let showRetry = false;
  let stopState: 'pending' | 'unavailable' | 'failed' | 'already-finished';

  if (entry.phase === 'already_finished') {
    message = text.stopAlreadyFinished;
    stopState = 'already-finished';
  } else if (entry.phase === 'failed') {
    message = text.stopFailed;
    showRetry = true;
    stopState = 'failed';
  } else if (connectionStatus === 'unavailable') {
    message = text.stopUnavailable;
    showRetry = true;
    stopState = 'unavailable';
  } else {
    message = text.stopPending;
    stopState = 'pending';
  }

  return (
    <div
      role="status"
      data-testid="pending-stop-notice"
      data-stop-state={stopState}
      className="mb-2 flex items-center gap-2 rounded-xl border border-border-default bg-surface-subtle px-3 py-2"
    >
      <p className="min-w-0 flex-1 text-xs text-text-secondary">{message}</p>
      {showRetry && onRetryStop && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="pending-stop-retry"
          onClick={onRetryStop}
        >
          {text.stopRetry}
        </Button>
      )}
    </div>
  );
}
