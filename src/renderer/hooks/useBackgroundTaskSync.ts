import { useEffect } from 'react';
import type { AgentEventEnvelope } from '@shared/contract';
import type { TaskNotification } from '@shared/contract/backgroundTask';
import { BASH, RENDERER_POLLING } from '@shared/constants';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useSessionStore } from '../stores/sessionStore';
import { useMessageActionStore } from '../stores/messageActionStore';
import ipcService from '../services/ipcService';
import { hasNativeBridge } from '../api/transport';
import { createBackoffPoller } from '../utils/backoffPoller';
import { createLogger } from '../utils/logger';
import { toast } from './useToast';
import { useI18n } from './useI18n';
import type { Translations } from '../i18n';

const logger = createLogger('useBackgroundTaskSync');

interface UseBackgroundTaskSyncOptions {
  enabled?: boolean;
  pollInterval?: number;
}

function readTimeoutMinutes(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record.reason !== 'timeout') return null;
  const ms = typeof record.maxRuntimeMs === 'number' && record.maxRuntimeMs > 0
    ? record.maxRuntimeMs
    : BASH.BACKGROUND_MAX_RUNTIME;
  return Math.round(ms / 60_000);
}

function showTimeoutNotification(notification: TaskNotification, minutes: number, t: Translations): void {
  toast.error(t.chat.taskTimeoutNotice.replace('{minutes}', String(minutes)), {
    label: t.chat.taskTimeoutRerun,
    onClick: () => {
      // 发送通道绑定当前会话；用户已切走时不能把重跑请求发进别的会话。
      if (useSessionStore.getState().currentSessionId !== notification.sessionId) {
        logger.warn('Re-run skipped: current session differs from notification session', {
          notificationSessionId: notification.sessionId,
        });
        toast.info(t.chat.taskTimeoutRerunWrongSession);
        return;
      }
      void useMessageActionStore.getState().sendPrompt(t.chat.taskTimeoutRerunPrompt);
    },
  });
}

function showTaskNotification(notification: TaskNotification, t: Translations): void {
  const timeoutMinutes = notification.type === 'task_failed' ? readTimeoutMinutes(notification.payload) : null;
  if (timeoutMinutes !== null) {
    showTimeoutNotification(notification, timeoutMinutes, t);
    return;
  }
  const message = t.chat.taskNotificationWithLog.replace('{message}', notification.message);
  if (notification.type === 'task_failed') {
    toast.error(message);
    return;
  }
  if (notification.type === 'task_completed') {
    toast.success(message);
    return;
  }
  if (notification.type === 'task_cancelled' || notification.type === 'task_updated') {
    toast.info(message);
    return;
  }
  toast.warning(message);
}

export function useBackgroundTaskSync(options: UseBackgroundTaskSyncOptions = {}): void {
  const { t } = useI18n();
  const {
    enabled = true,
  } = options;
  const pollInterval = options.pollInterval ?? (
    hasNativeBridge()
      ? RENDERER_POLLING.BACKGROUND_TASK_FALLBACK
      : RENDERER_POLLING.BACKGROUND_TASK_BASE
  );
  const refreshTasks = useBackgroundTaskStore((state) => state.refreshTasks);
  const drainNotifications = useBackgroundTaskStore((state) => state.drainNotifications);
  const readRetryNonce = useBackgroundTaskStore((state) => state.readRetryNonce);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);

  useEffect(() => {
    if (!enabled) return;

    let statusReadBlocked = false;
    let stopPoller: (() => void) | undefined;

    const sync = async () => {
      if (statusReadBlocked) return;
      await refreshTasks();
      if (!currentSessionId) return;
      const notifications = await drainNotifications(currentSessionId);
      notifications.forEach((notification) => showTaskNotification(notification, t));
    };

    const syncUntilReadFailure = async () => {
      try {
        await sync();
      } catch (error) {
        // A failed ledger read cannot prove that a task is still running.
        // Freeze the last known projection and wait for an explicit user retry.
        // 0 rows ≠ failure（C.11）：store 未置位 readFailure 说明手头无任务，
        // 轮询继续追平，不把空台账的一次读失败冻结成永久停摆。
        if (useBackgroundTaskStore.getState().readFailure) {
          statusReadBlocked = true;
          stopPoller?.();
        }
        throw error;
      }
    };

    let invalidationTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = ipcService.on('agent:event', (event: AgentEventEnvelope) => {
      if (event.type !== 'background_task_ledger_changed') return;
      if (statusReadBlocked) return;
      if (invalidationTimer !== null) clearTimeout(invalidationTimer);
      invalidationTimer = setTimeout(() => {
        invalidationTimer = null;
        void syncUntilReadFailure().catch((error) => {
          logger.warn('Background task push sync failed', { error });
        });
      }, RENDERER_POLLING.BACKGROUND_TASK_INVALIDATION_DEBOUNCE);
    });

    if (pollInterval <= 0) {
      void syncUntilReadFailure().catch((error) => {
        logger.warn('Initial background task sync failed', { error });
      });
    } else {
      // 推送负责及时刷新；轮询仅用于丢失推送后的追平。
      const poller = createBackoffPoller(syncUntilReadFailure, {
        baseInterval: pollInterval,
        maxInterval: RENDERER_POLLING.MAX_BACKOFF,
        factor: RENDERER_POLLING.BACKOFF_FACTOR,
        onError: (error) => logger.warn('Background task sync failing, backing off', { error }),
        onRecover: () => logger.info('Background task sync recovered'),
      });
      poller.start();
      stopPoller = poller.stop;
    }

    return () => {
      unsubscribe?.();
      stopPoller?.();
      if (invalidationTimer !== null) clearTimeout(invalidationTimer);
    };
  }, [currentSessionId, drainNotifications, enabled, pollInterval, readRetryNonce, refreshTasks, t]);
}
