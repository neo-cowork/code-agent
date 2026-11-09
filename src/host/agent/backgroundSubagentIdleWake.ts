import { SUBAGENT_COMPLETION_NOTIFICATIONS } from '../../shared/constants';
import type { MessageMetadata } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';
import { formatSystemReminderForCompletions, type SubagentCompletionRecord } from './subagentCompletionNotification';

const logger = createLogger('BackgroundSubagentIdleWake');

interface PendingWakeBatch {
  timer: ReturnType<typeof setTimeout>;
}

const pendingWakeBySession = new Map<string, PendingWakeBatch>();
const idleTransitionCleanupBySession = new Map<string, () => void>();

function wakeKey(record: SubagentCompletionRecord): string | undefined {
  return record.sessionId;
}

async function flushWake(sessionId: string): Promise<void> {
  const batch = pendingWakeBySession.get(sessionId);
  if (!batch) return;
  pendingWakeBySession.delete(sessionId);

  try {
    const { getTaskManager } = await import('../task/TaskManager');
    const { getApplicationRunRegistry } = await import('../app/applicationRunRegistry');
    const taskManager = getTaskManager();
    const runRegistry = getApplicationRunRegistry();
    const state = taskManager.getSessionState(sessionId);
    const parentRunRegistered = runRegistry.hasSession(sessionId);
    if (state.status !== 'idle' || parentRunRegistered) {
      if (parentRunRegistered) {
        logger.info('skipped: parent run still registered', { sessionId });
        watchForIdleTransition(sessionId, runRegistry);
      }
      // 父会话在跑：不消费队列，交给工具结果提醒路径投递（单一消费点防双投递）。
      return;
    }

    const idleTransitionCleanup = idleTransitionCleanupBySession.get(sessionId);
    idleTransitionCleanup?.();
    idleTransitionCleanupBySession.delete(sessionId);

    const { getBackgroundSubagentRegistry } = await import('./backgroundSubagentRegistry');
    const records = getBackgroundSubagentRegistry().drainCompletionNotifications({ sessionId });
    const content = formatSystemReminderForCompletions(records);
    if (!content) return;

    const messageMetadata: MessageMetadata = {
      automation: {
        automationId: `background-subagent:${sessionId}`,
        automationType: 'role_wake',
        event: 'stage_ready',
        sourceSessionId: sessionId,
        status: 'running',
        title: 'Background subagent completed',
      },
    };

    await taskManager.startTask(
      sessionId,
      content,
      undefined,
      {
        mode: 'normal',
        historyVisibility: 'meta',
        maxIterations: 1,
      },
      messageMetadata,
      `background-subagent:${sessionId}:${Date.now()}`,
    );
  } catch (error) {
    logger.warn('Failed to wake idle parent session for background subagent completion', {
      sessionId,
      error: String(error),
    });
  }
}

function scheduleWakeForSession(sessionId: string): void {
  if (pendingWakeBySession.has(sessionId)) return;

  const timer = setTimeout(() => {
    void flushWake(sessionId);
  }, SUBAGENT_COMPLETION_NOTIFICATIONS.IDLE_WAKE_DEBOUNCE);
  pendingWakeBySession.set(sessionId, { timer });
}

function watchForIdleTransition(sessionId: string, runRegistry: { hasSession(id: string): boolean; onIdleTransition(listener: () => void): () => void }): void {
  if (idleTransitionCleanupBySession.has(sessionId)) return;

  const subscription: { cleanup?: () => void } = {};
  const onIdle = (): void => {
    if (runRegistry.hasSession(sessionId)) return;
    subscription.cleanup?.();
    idleTransitionCleanupBySession.delete(sessionId);
    scheduleWakeForSession(sessionId);
  };
  subscription.cleanup = runRegistry.onIdleTransition(onIdle);
  idleTransitionCleanupBySession.set(sessionId, subscription.cleanup);
}

export function scheduleBackgroundSubagentIdleWake(record: SubagentCompletionRecord): void {
  const sessionId = wakeKey(record);
  if (!sessionId) return;

  scheduleWakeForSession(sessionId);
}

