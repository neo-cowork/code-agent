import type { ToolApprovalPayload } from '../../../shared/contract/pendingApproval';
import type { AwaitingApprovalRun } from '../../../shared/contract/sessionAutomation';
import { resolveUnattendedRunIdentity } from '../../../shared/unattendedRunIdentity';
import { getDatabase } from '../core/databaseService';
import { createLogger } from '../infra/logger';

const logger = createLogger('SessionAutomationService');

/** Kept by the service so polling warns once per malformed pending session. */
export class AwaitingApprovalRunListing {
  private readonly warned = new Set<string>();

  list(): AwaitingApprovalRun[] {
    let repo;
    try {
      repo = getDatabase().getPendingApprovalRepo();
    } catch {
      return [];
    }
    const rows = [
      ...repo.listByKindAndStatus('tool_approval', 'pending'),
      ...repo.listByKindAndStatus('directory_access', 'pending'),
    ];
    const out: AwaitingApprovalRun[] = [];
    const seen = new Set<string>();
    const invalidSessions = new Set<string>();
    for (const row of rows) {
      let payload: Partial<ToolApprovalPayload>;
      try {
        payload = JSON.parse(row.payloadJson) as Partial<ToolApprovalPayload>;
      } catch {
        logger.warn('Awaiting-approval run skipped: payload unreadable', { requestId: row.id });
        continue;
      }
      const sessionId = payload.sessionId ?? row.coordinatorId ?? null;
      if (!sessionId) {
        logger.warn('Awaiting-approval run skipped: no sessionId', { requestId: row.id });
        continue;
      }
      if (seen.has(sessionId)) continue;
      const session = getDatabase().getSession(sessionId);
      if (!session) {
        logger.warn('Awaiting-approval run skipped: session row missing', { requestId: row.id, sessionId });
        continue;
      }
      const origin = session.origin;
      if (!origin || (origin.kind !== 'cron' && origin.kind !== 'heartbeat')) {
        continue;
      }
      const identity = resolveUnattendedRunIdentity(session);
      if (!identity) {
        invalidSessions.add(sessionId);
        if (!this.warned.has(sessionId)) {
          logger.warn('Awaiting-approval run skipped: session origin has no job id', { requestId: row.id, sessionId, kind: origin.kind });
          this.warned.add(sessionId);
        }
        continue;
      }
      seen.add(sessionId);
      out.push({
        ...(identity.kind === 'cron' ? { jobId: identity.jobId } : { runKey: identity.runKey, runKind: identity.kind, title: session.title }),
        executionId: session.sourceRunId ?? null,
        requestId: row.id,
        sessionId,
        requestedAt: payload.requestedAt ?? row.submittedAt,
        ...(payload.tool ? { tool: payload.tool } : {}),
        ...((payload.argsPreview ?? payload.argsSummary) ? { commandPreview: payload.argsPreview ?? payload.argsSummary } : {}),
      });
    }
    for (const sessionId of this.warned) if (!invalidSessions.has(sessionId)) this.warned.delete(sessionId);
    return out;
  }
}
