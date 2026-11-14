import type { Message, MessageMetadata } from '../../../shared/contract';
import type { SystemEventMessageMetadata } from '../../../shared/contract/systemEventRegistry';

/** One delivery channel for early background stops: independent of assistant aggregation and wake turns. */
export async function recordBackgroundTaskStopNote(
  sessionId: string,
  title: string,
  content: string,
  detail: NonNullable<MessageMetadata['backgroundTaskStopped']>,
): Promise<void> {
  const [{ getSessionManager }, { getTaskManager }] = await Promise.all([
    import('../infra/sessionManager'), import('../../task/TaskManager'),
  ]);
  const message: Message = {
    id: `background-task-stopped-${detail.taskId}`,
    role: 'system',
    content: `「${title}」：${content}`,
    timestamp: Date.now(),
    metadata: { backgroundTaskStopped: detail } satisfies SystemEventMessageMetadata,
  };
  await getSessionManager().addMessageToSession(sessionId, message);
  getTaskManager().emitAgentEventForSession(sessionId, { type: 'message', data: message });
}
