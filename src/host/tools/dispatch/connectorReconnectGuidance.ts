import type { ToolResult } from '../../protocol/tools';
import { findConnectorIdForToolName } from '../../../shared/contract/workbenchTools';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ConnectorAvailability');
const RECONNECT_EXIT = 'The complete user-facing answer is exactly this single everyday sentence: '
  + '“这次还没读到所需数据，请在设置 > 连接器重新连接后再试。” Translate only that sentence for another user language (navigation: Settings > Connectors). '
  + 'Keep diagnostic details in the existing structured metadata, outside that sentence. Wait for the user to reconnect before trying again; connector authorization cannot be replaced with shell commands or background execution.';

// 连接器根本没开/没注册时，通用「没读到数据」句不告诉用户日历是关着的，模型也容易转而
// 用别处数据答「今天没有日程」。这种情形换成点名连接器的版本，并禁止拿别处数据或声称「没有」。
const NOT_CONNECTED_NAMES: Record<string, { name: string; data: string; empty: string }> = {
  calendar: { name: '日历', data: '日程', empty: 'events' },
  mail: { name: '邮件', data: '邮件', empty: 'emails' },
  reminders: { name: '提醒事项', data: '提醒事项', empty: 'reminders' },
};

function notConnectedExit(connectorId: string): string {
  const copy = NOT_CONNECTED_NAMES[connectorId];
  if (!copy) return RECONNECT_EXIT;
  return 'The complete user-facing answer is exactly this single everyday sentence: '
    + `“${copy.name}还没有连接，所以这次看不到你的${copy.data}，请在设置 > 连接器打开后再试。” Translate only that sentence for another user language (navigation: Settings > Connectors). `
    + `Do not answer this question from other sources (for example meeting records or files), and never state that there are no ${copy.empty}. `
    + 'Wait for the user to connect it before trying again; connector authorization cannot be replaced with shell commands or background execution.';
}

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
  const notConnected = reason === 'not-enabled-or-registered' || (reason === 'status-not-connected' && status?.unavailable === true);
  const exit = notConnected ? notConnectedExit(connectorId) : RECONNECT_EXIT;
  if (result.ok) {
    if (typeof result.output !== 'string' || result.output.includes('Settings > Connectors')) return result;
    return { ...result, output: exit as T };
  }
  return result.error.includes('Settings > Connectors') ? result : { ...result, error: exit };
}
