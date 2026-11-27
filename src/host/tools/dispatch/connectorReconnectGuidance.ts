import type { ToolResult } from '../../protocol/tools';
import { findConnectorIdForToolName } from '../../../shared/contract/workbenchTools';
import { CONNECTOR_EXIT_PREFIX, getConnectorReconnectCopy, getSpecificConnectorStatusCopy } from '../../../shared/i18n/connectorReconnect';
import type { NativeConnectorDetailCode } from '../../../shared/ipc/types';
import { getHostUiLocale } from '../../config/hostUiLocale';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ConnectorAvailability');
// 真实入口：连接器页在「能力中心」里的「连接器」tab（renderer capabilityHub.ts title/tabConnectors）。
const ENTRY_EN = 'Capability Hub > Connectors';
// 幂等标记：已带入口或出口前缀的结果不再改写（Settings > Connectors 是 mcpErrors 旧句，同样视为已带出口）。
const ENTRY_MARKERS = [ENTRY_EN, 'Settings > Connectors'];
const hasGuidance = (text: string): boolean => text.includes(CONNECTOR_EXIT_PREFIX) || ENTRY_MARKERS.some((m) => text.includes(m));

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

function isPlatformDetailCode(code: NativeConnectorDetailCode | undefined): boolean {
  return code === 'platform_unsupported' || code === 'calendar_desktop_only';
}

function platformUnsupportedExit(connectorId: string, locale: 'en' | 'zh'): ConnectorExit {
  const detailCode: NativeConnectorDetailCode = connectorId === 'calendar' ? 'calendar_desktop_only' : 'platform_unsupported';
  const userMessage = getSpecificConnectorStatusCopy(detailCode)?.[locale] ?? '';
  const emptyGuard = connectorId === 'calendar' || connectorId === 'mail' || connectorId === 'reminders'
    ? ` Do not answer this question from other sources (for example meeting records or files), and never state that there are no ${EMPTY_NOUN[connectorId]}.`
    : '';
  return {
    userMessage,
    error: `${CONNECTOR_EXIT_PREFIX}${userMessage}” Translate only that sentence for another user language. `
      + 'This is not a connection problem and reconnecting will not help; do not send the user to the Connectors page. '
      + 'This connector works only in the Agent Neo desktop app on macOS.'
      + `${emptyGuard} `
      + 'Keep diagnostic details in the existing structured metadata, outside that sentence; this cannot be replaced with shell commands or background execution.',
  };
}

/** Both protocol dispatch paths preserve the failure and add its missing exit. */
export function withConnectorReconnectGuidance<T>(toolName: string, result: ToolResult<T>): ToolResult<T> {
  const connectorId = findConnectorIdForToolName(toolName);
  if (!connectorId) return result;
  const status = result.meta?.status as { connected?: boolean; unavailable?: boolean; readiness?: string; detailCode?: NativeConnectorDetailCode } | undefined;
  const existing = result.meta?.modelGuidance;
  // The status formatter already supplies the appropriate output, preview and model guidance.
  if (result.ok && status?.connected === false && typeof existing === 'string' && getSpecificConnectorStatusCopy(status.detailCode)) {
    return result;
  }
  const remindersRead = toolName === 'reminders';
  const nonDarwin = process.platform !== 'darwin';
  const isPlatformUnsupported = (!result.ok && result.code === 'unavailable')
    || (status?.connected === false && isPlatformDetailCode(status.detailCode))
    || (nonDarwin && (
      (!result.ok && result.code === 'NOT_INITIALIZED')
      || (status?.connected === false && status.unavailable === true)
    ));
  const reason = isPlatformUnsupported ? 'platform-unsupported'
    : !result.ok && result.code === 'NOT_INITIALIZED' ? 'not-enabled-or-registered'
    : remindersRead && !result.ok && result.code === 'not_authorized' && result.meta?.accessProbeDenied === true ? 'access-probe-denied'
    : !result.ok && result.code === 'not_authorized' ? 'not-authorized'
    : remindersRead && status?.connected === false && !status.unavailable && status.readiness === 'unchecked' ? 'status-unchecked'
    : status?.connected === false ? 'status-not-connected' : undefined;
  if (!reason) return result;
  logger.warn(
    reason === 'platform-unsupported' ? 'Connector call unsupported on current platform' : 'Connector call needs reconnection',
    { connectorId, toolName, reason },
  );
  const locale = getHostUiLocale();
  const notConnected = reason === 'not-enabled-or-registered' || (reason === 'status-not-connected' && status?.unavailable === true);
  const copy = getConnectorReconnectCopy(locale);
  const exit = reason === 'platform-unsupported' ? platformUnsupportedExit(connectorId, locale)
    : reason === 'status-unchecked' || reason === 'access-probe-denied' ? remindersAccessExit(reason, copy)
    : notConnected ? notConnectedExit(connectorId, copy) : reconnectExit(copy.reconnect);
  if (result.ok) {
    // 输出只留事实；给模型的指引放 meta.modelGuidance（经 serializeToolResultsForModel 仍进模型 JSON）。
    if (typeof result.output !== 'string' || (typeof existing === 'string' && hasGuidance(existing))) return result;
    // exit.error 自称「完整答复」：模型侧用它代替事实句（与旧行为一致），界面侧 output 仍只有事实。
    const artifact = result.meta?.artifact;
    const updatedArtifact = artifact && typeof artifact === 'object' && 'preview' in artifact
      ? { ...artifact, preview: exit.userMessage, contentLength: exit.userMessage.length }
      : artifact;
    return { ...result, output: exit.userMessage as T, meta: { ...result.meta, ...(updatedArtifact ? { artifact: updatedArtifact } : {}), modelGuidance: exit.error, modelGuidanceReplacesOutput: true } };
  }
  return hasGuidance(result.error) ? result : { ...result, ...exit };
}
