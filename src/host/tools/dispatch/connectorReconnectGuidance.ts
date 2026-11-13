import type { ToolResult } from '../../protocol/tools';
import { findConnectorIdForToolName } from '../../../shared/contract/workbenchTools';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ConnectorAvailability');
const RECONNECT_EXIT = 'Ask the user in one sentence to reconnect in Settings > Connectors, then try again. Do not substitute shell commands or background execution for connector authorization.';

/** Both protocol dispatch paths preserve the failure and add its missing exit. */
export function withConnectorReconnectGuidance<T>(toolName: string, result: ToolResult<T>): ToolResult<T> {
  const connectorId = findConnectorIdForToolName(toolName);
  if (!connectorId) return result;
  const status = result.meta?.status as { connected?: boolean; unavailable?: boolean } | undefined;
  const reason = !result.ok && result.code === 'NOT_INITIALIZED' ? 'not-enabled-or-registered'
    : !result.ok && result.code === 'not_authorized' ? 'not-authorized'
    : status?.connected === false ? 'status-not-connected' : undefined;
  if (!reason) return result;
  logger.warn('Connector call needs reconnection', { connectorId, toolName, reason });
  if (result.ok) {
    if (typeof result.output !== 'string' || result.output.includes('Settings > Connectors')) return result;
    return { ...result, output: `${result.output}\n${RECONNECT_EXIT}` as T };
  }
  return result.error.includes('Settings > Connectors') ? result : { ...result, error: `${result.error}\n${RECONNECT_EXIT}` };
}
