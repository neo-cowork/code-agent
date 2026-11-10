import type { WorkbenchMcpRegistryItem } from './workbenchCapabilityRegistry';
import type { zh } from '../i18n/zh';

type ConnectorCardStatusLabels = (typeof zh)['settings']['mcp']['grid']['cardStatus'];
type ConnectorCardConnectionState = WorkbenchMcpRegistryItem['lifecycle']['connectionState'];

function getStatusLabel(
  server: WorkbenchMcpRegistryItem,
  labels: ConnectorCardStatusLabels,
  connectionState: ConnectorCardConnectionState,
): string {
  if (connectionState === 'connecting') return labels.connecting;
  if (!server.enabled) return labels.disabled;

  switch (connectionState) {
    case 'connected':
      return labels.connected;
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
