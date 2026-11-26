import type { WorkbenchMcpRegistryItem } from './workbenchCapabilityRegistry';
import type { zh } from '../i18n/zh';

type ConnectorCardStatusLabels = (typeof zh)['settings']['mcp']['grid']['cardStatus'];
type ConnectorCardConnectionState = WorkbenchMcpRegistryItem['lifecycle']['connectionState'];

/** 唯一的"已连接"判据：徽标、顶部计数、状态点、断开按钮共用。 */
export function isConnectorCardConnected(
  server: WorkbenchMcpRegistryItem,
  connectionState: ConnectorCardConnectionState,
): boolean {
  return server.enabled && connectionState === 'connected';
}

export function countConnectedMcpServers(
  servers: readonly WorkbenchMcpRegistryItem[],
  installingServerIds: ReadonlySet<string> = new Set(),
): number {
  return servers.filter((server) => isConnectorCardConnected(
    server,
    installingServerIds.has(server.id) ? 'connecting' : server.lifecycle.connectionState,
  )).length;
}

function getStatusLabel(
  server: WorkbenchMcpRegistryItem,
  labels: ConnectorCardStatusLabels,
  connectionState: ConnectorCardConnectionState,
): string {
  if (connectionState === 'connecting') return labels.connecting;
  if (!server.enabled) return labels.disabled;
  if (isConnectorCardConnected(server, connectionState)) return labels.connected;

  switch (connectionState) {
    case 'lazy':
      return labels.connectsWhenNeeded;
    case 'error':
      return labels.connectionFailed;
    default:
      return labels.notConnected;
  }
}

export function getConnectorCardPresentation(
  server: WorkbenchMcpRegistryItem,
  labels: ConnectorCardStatusLabels,
  options?: {
    connectionState?: ConnectorCardConnectionState;
    displayName?: string;
  },
): { statusLabel: string; description?: string; title: string } {
  const connectionState = options?.connectionState ?? server.lifecycle.connectionState;
  const description = server.description || server.error || undefined;
  const title = [options?.displayName || server.label, description].filter(Boolean).join('\n');

  return {
    statusLabel: getStatusLabel(server, labels, connectionState),
    description,
    title,
  };
}
