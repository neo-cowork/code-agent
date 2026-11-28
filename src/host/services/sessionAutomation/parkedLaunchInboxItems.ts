// Review-inbox rows for team-launch approvals (pending_approvals kind='launch').
// Lives beside sessionAutomationService because that file is at the max-lines limit.

import type { ParkedApprovalInboxItem, ToolApprovalPayload } from '../../../shared/contract/pendingApproval';
import type { SwarmLaunchRequest } from '../../../shared/contract/swarm';
import { LAUNCH_APPROVAL_TOOL } from '../../../shared/constants/pendingApproval';
import type { PendingApprovalRepository } from '../core/repositories/PendingApprovalRepository';
import { createLogger } from '../infra/logger';

const logger = createLogger('ParkedLaunchInboxItems');

type SessionPresentation = (
  sessionId: string | null,
  requestId: string,
  payload: Partial<ToolApprovalPayload>,
) => Partial<ParkedApprovalInboxItem>;

/**
 * Pending launch rows only: a settled or restart-voided launch has nothing left to decide,
 * so it never shows up here. `presentSession` is the same helper tool rows use.
 */
export function listPendingLaunchInboxItems(
  repo: PendingApprovalRepository,
  presentSession: SessionPresentation,
): ParkedApprovalInboxItem[] {
  const items: ParkedApprovalInboxItem[] = [];
  for (const row of repo.listByKindAndStatus('launch', 'pending')) {
    let payload: Partial<SwarmLaunchRequest> = {};
    try {
      payload = (JSON.parse(row.payloadJson) ?? {}) as Partial<SwarmLaunchRequest>;
    } catch {
      logger.warn('Launch approval payload unreadable; listing the row without session details', { requestId: row.id });
    }
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
    items.push({
      id: row.id,
      kind: 'launch',
      sessionId,
      ...presentSession(sessionId, row.id, {}),
      tool: LAUNCH_APPROVAL_TOOL,
      requestedAt: typeof payload.requestedAt === 'number' ? payload.requestedAt : row.submittedAt,
      status: 'pending',
      ...(typeof payload.agentCount === 'number' ? { launchMemberCount: payload.agentCount } : {}),
    });
  }
  return items;
}
