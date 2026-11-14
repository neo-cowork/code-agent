import type { PermissionRequest } from '../../shared/contract/permission';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import { getSessionAutomationService } from '../services/sessionAutomation/sessionAutomationService';
import { classifyConnectorTool } from './connectorToolAccess';

const logger = createLogger('ConnectorApprovalDetails');

/** Overwrite untrusted lookalike fields before the pending request is stored/emitted. */
export function connectorApprovalDetails(request: Pick<PermissionRequest, 'type' | 'tool' | 'sessionId' | 'details'>): PermissionRequest['details'] {
  const details = { ...request.details };
  delete details.connectorAccess;
  delete details.purpose;
  const access = classifyConnectorTool(request.tool);
  if (!access) return details;
  details.connectorAccess = access;
  if (!request.sessionId) return details;
  try {
    const session = getDatabase().getSession(request.sessionId);
    let title = session?.title;
    if (session?.origin?.id) {
      try {
        title = getSessionAutomationService().getBySourceRefId(session.origin.id)?.title || title;
      } catch {
        logger.warn('Connector approval automation title unavailable; using session title');
      }
    }
    if (title?.trim()) details.purpose = title.trim();
  } catch {
    logger.warn('Connector approval purpose unavailable', { sessionId: request.sessionId });
  }
  return details;
}
