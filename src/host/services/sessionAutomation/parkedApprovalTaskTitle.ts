import type { ToolApprovalPayload } from '../../../shared/contract/pendingApproval';
import { deriveDelegatedSessionTitle } from '../../tools/modules/delegation/delegatedSessionTitle';
import { stripTelemetryRecoveryNoticeOrResidue } from '../../../shared/telemetryRecovery';
import { getDatabase } from '../core/databaseService';
import { createLogger } from '../infra/logger';

const logger = createLogger('ParkedApprovalTaskTitle');

/** Bind the task name to this tool call, never to later user messages in the same channel. */
export function approvalTaskTitle(sessionId: string | null, payload: Partial<ToolApprovalPayload>): string | undefined {
  const toolCallId = payload.toolCallId ?? payload.argsRef?.toolCallId;
  if (!sessionId || !toolCallId) return undefined;
  try {
    const database = getDatabase();
    const session = database.getSession(sessionId);
    if (!session || !/^\[Channel\]/i.test(session.title ?? '')) return undefined;
    const messages = database.getMessages(sessionId);
    const callIndex = messages.findIndex((message) => message.role === 'assistant'
      && message.toolCalls?.some((call) => call.id === toolCallId));
    for (let index = callIndex - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user') continue;
      // 标题派生共用恢复提示清洗：只剩提示的消息不算有效正文，继续往前找。
      const content = stripTelemetryRecoveryNoticeOrResidue(message.content);
      if (content.trim()) return deriveDelegatedSessionTitle(content);
    }
  } catch {
    logger.warn('Approval task title unavailable');
  }
  return undefined;
}
