import { SUBAGENT_COMPLETION_NOTIFICATIONS } from '../../shared/constants';
import type { MessageMetadata } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';
import { formatSystemReminderForCompletions, type SubagentCompletionRecord } from './subagentCompletionNotification';

const logger = createLogger('BackgroundSubagentIdleWake');

interface PendingWakeBatch {
  timer: ReturnType<typeof setTimeout>;
}

const pendingWakeBySession = new Map<string, PendingWakeBatch>();

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
    const taskManager = getTaskManager();
    const state = taskManager.getSessionState(sessionId);
    if (state.status !== 'idle') {
      // 父会话在跑：不消费队列，交给工具结果提醒路径投递（单一消费点防双投递）。
      return;
    }

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

    recordFailure = async (error: unknown): Promise<void> => {
      const task = records[0];
      if (!task) return;
      const firstLine = task.title.trim().split(/\r?\n/, 1)[0].trim();
      const characters = Array.from(firstLine);
      const shortName = characters.length > 24 ? `${characters.slice(0, 24).join('').trimEnd()}…` : firstLine;
      const message = error instanceof Error ? error.message : String(error);
      try {
        const { formatBackgroundWakeFailureNote, recordBackgroundWakeFailureNote } = await import('../services/commandCenter/foregroundWake');
        await recordBackgroundWakeFailureNote(
          sessionId,
          formatBackgroundWakeFailureNote(shortName),
          { taskId: task.agentId, reason: message.includes('no live owner lease') ? 'owner_missing' : 'wake_failed' },
        );
      } catch (noteError) {
        logger.warn('Background subagent wake failure note not recorded', {
          sessionId,
          taskId: task.agentId,
          error: String(noteError),
        });
      }
    };
    let failureMessage: string | undefined;
    const stopObserving = taskManager.observeAgentEvents((eventSessionId, event, taskId) => {
      if (eventSessionId !== sessionId || taskId || event.type !== 'error' || failureMessage) return;
      const data = event.data as { message?: unknown };
      failureMessage = typeof data.message === 'string' ? data.message : String(data.message);
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
      error: String(error),
    });
    await recordFailure?.(error);
  }
}

export function scheduleBackgroundSubagentIdleWake(record: SubagentCompletionRecord): void {
  const sessionId = wakeKey(record);
  if (!sessionId) return;

  if (pendingWakeBySession.has(sessionId)) return;

  const timer = setTimeout(() => {
    void flushWake(sessionId);
  }, SUBAGENT_COMPLETION_NOTIFICATIONS.IDLE_WAKE_DEBOUNCE);
  pendingWakeBySession.set(sessionId, { timer });
}

