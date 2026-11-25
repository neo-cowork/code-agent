import type { ToolResult } from '../../protocol/tools';
import { findConnectorIdForToolName } from '../../../shared/contract/workbenchTools';
import { CONNECTOR_EXIT_PREFIX, getConnectorReconnectCopy } from '../../../shared/i18n/connectorReconnect';
import { getHostUiLocale } from '../../config/hostUiLocale';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ConnectorAvailability');
// 真实入口：连接器页在「能力中心」里的「连接器」tab（renderer capabilityHub.ts title/tabConnectors）。
const ENTRY_EN = 'Capability Hub > Connectors';
// 幂等标记：已带入口的结果不再改写（Settings > Connectors 是 mcpErrors 旧句，同样视为已带出口）。
const ENTRY_MARKERS = [ENTRY_EN, 'Settings > Connectors'];
const hasEntry = (text: string): boolean => ENTRY_MARKERS.some((m) => text.includes(m));

interface ConnectorExit {
  error: string;
  userMessage: string;
}

type ReconnectCopy = ReturnType<typeof getConnectorReconnectCopy>;

function reconnectExit(userMessage: string): ConnectorExit {
  return {
    userMessage,
    error: `${CONNECTOR_EXIT_PREFIX}${userMessage}” Translate only that sentence for another user language (navigation: ${ENTRY_EN}). `
      + 'Keep diagnostic details in the existing structured metadata, outside that sentence. Wait for the user to reconnect before trying again; connector authorization cannot be replaced with shell commands or background execution.',
  };
}

function remindersAccessExit(reason: 'status-unchecked' | 'access-probe-denied', copy: ReconnectCopy): ConnectorExit {
  const userMessage = reason === 'status-unchecked' ? copy.remindersUnchecked : copy.remindersDenied;
  return {
    userMessage,
    error: `${CONNECTOR_EXIT_PREFIX}${userMessage}” Translate only that sentence for another user language (navigation: ${ENTRY_EN}, action: Check and authorize when prompted). `
      + 'Keep diagnostic details in the existing structured metadata, outside that sentence. Wait for the user to authorize access before trying again; connector authorization cannot be replaced with shell commands or background execution.',
  };
}

// A disabled connector is unavailable data, rather than an empty calendar or mailbox.
const EMPTY_NOUN = { calendar: 'events', mail: 'emails', reminders: 'reminders' } as const;

function notConnectedExit(connectorId: string, copy: ReconnectCopy): ConnectorExit {
  if (connectorId !== 'calendar' && connectorId !== 'mail' && connectorId !== 'reminders') {
    return reconnectExit(copy.reconnect);
  }
  const userMessage = copy[connectorId];
  return {
    userMessage,
    error: `${CONNECTOR_EXIT_PREFIX}${userMessage}” Translate only that sentence for another user language (navigation: ${ENTRY_EN}). `
      + `Do not answer this question from other sources (for example meeting records or files), and never state that there are no ${EMPTY_NOUN[connectorId]}. `
      + 'Wait for the user to connect it before trying again; connector authorization cannot be replaced with shell commands or background execution.',
  };
}

/** Both protocol dispatch paths preserve the failure and add its missing exit. */
export function withConnectorReconnectGuidance<T>(toolName: string, result: ToolResult<T>): ToolResult<T> {
  const connectorId = findConnectorIdForToolName(toolName);
  if (!connectorId) return result;
  const status = result.meta?.status as { connected?: boolean; unavailable?: boolean; readiness?: string } | undefined;
  const remindersRead = toolName === 'reminders';
  const reason = !result.ok && result.code === 'NOT_INITIALIZED' ? 'not-enabled-or-registered'
    : remindersRead && !result.ok && result.code === 'not_authorized' && result.meta?.accessProbeDenied === true ? 'access-probe-denied'
    : !result.ok && result.code === 'not_authorized' ? 'not-authorized'
    : remindersRead && status?.connected === false && !status.unavailable && status.readiness === 'unchecked' ? 'status-unchecked'
    : status?.connected === false ? 'status-not-connected' : undefined;
  if (!reason) return result;
  logger.warn('Connector call needs reconnection', { connectorId, toolName, reason });
  const notConnected = reason === 'not-enabled-or-registered' || (reason === 'status-not-connected' && status?.unavailable === true);
  const copy = getConnectorReconnectCopy(getHostUiLocale());
  const exit = reason === 'status-unchecked' || reason === 'access-probe-denied' ? remindersAccessExit(reason, copy)
    : notConnected ? notConnectedExit(connectorId, copy) : reconnectExit(copy.reconnect);
  if (result.ok) {
    if (typeof result.output !== 'string' || hasEntry(result.output)) return result;
    const artifact = result.meta?.artifact;
    const meta = artifact && typeof artifact === 'object' && 'preview' in artifact
      ? { ...result.meta, artifact: { ...artifact, preview: exit.userMessage } }
      : result.meta;
    return { ...result, output: exit.error as T, ...(meta ? { meta } : {}) };
  }
  return hasEntry(result.error) ? result : { ...result, ...exit };
}
