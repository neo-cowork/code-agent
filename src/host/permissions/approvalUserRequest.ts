import type { PermissionRequest } from '../../shared/contract/permission';
import {
  APPROVAL_USER_REQUEST_LOOKBACK_MESSAGES,
  APPROVAL_USER_REQUEST_MAX_CHARS,
} from '../../shared/constants';
import { isTelemetryRecoveredMessage } from '../../shared/telemetryRecovery';
import { stripInlineAttachmentBlocks } from '../../shared/utils/messageAttachments';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ApprovalUserRequest');

/**
 * Host-owned quote of what the user actually typed. Any incoming
 * `userRequest` / `startedByAutomation` (model or renderer supplied) is discarded first.
 * Scheduled/background sessions have no human typing, so they get a flag instead of a quote.
 */
export function withUserRequestQuote(
  sessionId: string | undefined,
  incoming: PermissionRequest['details'],
): PermissionRequest['details'] {
  const details = { ...incoming };
  delete details.userRequest;
  delete details.startedByAutomation;
  if (!sessionId) return details;
  try {
    const db = getDatabase();
    if (db.getSession(sessionId)?.origin) {
      details.startedByAutomation = true;
      return details;
    }
    const recent = db.getRecentMessages(sessionId, APPROVAL_USER_REQUEST_LOOKBACK_MESSAGES);
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const message = recent[i];
      if (message.role !== 'user' || isTelemetryRecoveredMessage(message)) continue;
      if (typeof message.content !== 'string') continue;
      const text = stripInlineAttachmentBlocks(message.content).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const chars = Array.from(text);
      const truncated = chars.length > APPROVAL_USER_REQUEST_MAX_CHARS;
      details.userRequest = {
        text: truncated ? chars.slice(0, APPROVAL_USER_REQUEST_MAX_CHARS).join('').trimEnd() : text,
        truncated,
      };
      return details;
    }
  } catch (err) {
    logger.warn('Approval user request quote unavailable', { sessionId, err });
  }
  return details;
}
