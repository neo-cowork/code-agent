import { SUBAGENT_COMPLETION_NOTIFICATIONS } from '../../shared/constants';
import type { MessageMetadata } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';
import { formatSystemReminderForCompletions, type SubagentCompletionRecord } from './subagentCompletionNotification';
import { isSessionNotAccessibleError } from '../services/commandCenter/sessionAccessRetry';

const logger = createLogger('BackgroundSubagentIdleWake');

function isRunSessionConflict(error: unknown): boolean {
  const candidate = error as { code?: unknown; name?: unknown } | null;
  return candidate?.code === 'RUN_SESSION_CONFLICT' || candidate?.name === 'RunSessionConflictError';
}

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
  let recordFailure: ((error: unknown) => Promise<void>) | undefined;

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
    const content = formatSystemReminderForCompletions(records, { delivery: 'wake' });
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

    recordFailure = async (error: unknown): Promise<void> => {
      const task = records[0];
      if (!task) return;
      const firstLine = task.title.trim().split(/\r?\n/, 1)[0].trim();
      const characters = Array.from(firstLine);
      const shortName = characters.length > 24 ? `${characters.slice(0, 24).join('').trimEnd()}…` : firstLine;
      const message = error instanceof Error ? error.message : String(error);
      try {
        // 写不进（登录恢复窗口里会话对当前 owner 不可读）时，这个包装会等登录态
        // 恢复再补写一次——失败句不能跟着唤醒轮一起消失。
        const { recordBackgroundWakeFailureNoteWithOwnerRetry } = await import('../services/commandCenter/backgroundWakeNoteRetry');
        await recordBackgroundWakeFailureNoteWithOwnerRetry({
          sessionId,
          taskId: task.agentId,
          shortName,
          reason: message.includes('no live owner lease') ? 'owner_missing' : 'wake_failed',
        });
      } catch (noteError) {
        logger.warn('Background subagent wake failure note not recorded', {
          sessionId,
          taskId: task.agentId,
          error: String(noteError),
        });
      }
    };
    let failureMessage: string | undefined;
    let reportedToUser = false;
    const stopObserving = taskManager.observeAgentEvents((eventSessionId, event, taskId) => {
      if (eventSessionId !== sessionId || taskId) return;
      if (event.type === 'message') {
        const message = event.data as { role?: unknown; content?: unknown; toolCalls?: unknown };
        if (message.role === 'assistant' && typeof message.content === 'string' && message.content.trim()
          && !(Array.isArray(message.toolCalls) && message.toolCalls.length > 0)) {
          reportedToUser = true;
        }
        return;
      }
      if (event.type !== 'error' || failureMessage) return;
      const data = event.data as { message?: unknown };
      const text = typeof data.message === 'string' ? data.message : String(data.message);
      // 通知轮只有 1 步预算，写完汇报恰好用满；此时的 "Max iterations reached" 不是失败。
      if (reportedToUser && text === 'Max iterations reached') {
        logger.info('Background wake turn used its single step to report; ignoring max-iterations marker', { sessionId });
        return;
      }
      failureMessage = text;
    });
    try {
      await taskManager.startTask(
        sessionId,
        content,
        undefined,
        {
          mode: 'normal',
          inputHistoryVisibility: 'meta',
          maxIterations: 1,
          disableAutoAgent: true,
        },
        messageMetadata,
        `background-subagent:${sessionId}:${Date.now()}`,
      );
    } finally {
      stopObserving();
    }
    if (failureMessage) await recordFailure(failureMessage);
  } catch (error) {
    logger.warn('Failed to wake idle parent session for background subagent completion', {
      sessionId,
      reason: isRunSessionConflict(error)
        ? 'run_session_conflict'
        : isSessionNotAccessibleError(error)
          ? 'session_not_accessible_for_current_owner'
          : 'wake_start_failed',
      error: String(error),
    });
    await recordFailure?.(error);
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

