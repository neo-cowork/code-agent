import type { ToolResult } from '../../protocol/tools';
import { findConnectorIdForToolName } from '../../../shared/contract/workbenchTools';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ConnectorAvailability');
const RECONNECT_EXIT = 'The complete user-facing answer is exactly this single everyday sentence: '
  + '“这次还没读到所需数据，请在设置 > 连接器重新连接后再试。” Translate only that sentence for another user language (navigation: Settings > Connectors). '
  + 'Keep diagnostic details in the existing structured metadata, outside that sentence. Wait for the user to reconnect before trying again; connector authorization cannot be replaced with shell commands or background execution.';

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
    return { ...result, output: RECONNECT_EXIT as T };
  }
  return result.error.includes('Settings > Connectors') ? result : { ...result, error: RECONNECT_EXIT };
}
