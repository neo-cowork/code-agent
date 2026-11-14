import type { PermissionRequest } from '../../shared/contract/permission';
import type { SessionOriginKind } from '../../shared/contract/session';
import {
  APPROVAL_USER_REQUEST_LOOKBACK_MESSAGES,
  APPROVAL_USER_REQUEST_MAX_CHARS,
} from '../../shared/constants';
import { isTelemetryRecoveredMessage } from '../../shared/telemetryRecovery';
import { stripInlineAttachmentBlocks } from '../../shared/utils/messageAttachments';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ApprovalUserRequest');
const AUTOMATION_ORIGIN_KINDS: ReadonlySet<SessionOriginKind> = new Set(['cron', 'heartbeat', 'headless']);
const MODEL_DRIVEN_ORIGIN_KINDS: ReadonlySet<SessionOriginKind> = new Set(['subagent', 'agent_session_manager']);

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
    // Only non-human origins skip the quote. manual/channel/import/retry sessions are the
    // user's own conversations (fork, IM group chat, import) and keep the quote.
    const originKind = db.getSession(sessionId)?.origin?.kind;
    if (originKind && AUTOMATION_ORIGIN_KINDS.has(originKind)) {
      details.startedByAutomation = true;
      return details;
    }
    // Child-agent sessions: their user rows are briefs written by a model, never the human's words.
    if (originKind && MODEL_DRIVEN_ORIGIN_KINDS.has(originKind)) return details;
    const recent = db.getRecentMessages(sessionId, APPROVAL_USER_REQUEST_LOOKBACK_MESSAGES);
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const message = recent[i];
      // isMeta user rows are host/model-injected (e.g. a delegated-task brief the model wrote), not the human's words.
      if (message.role !== 'user' || message.isMeta || isTelemetryRecoveredMessage(message)) continue;
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
