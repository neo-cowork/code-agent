import React from 'react';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { interpolate } from '../../../i18n/interpolate';
import { useConnectorRequiredStore, type ConnectorRequiredEntry } from '../../../stores/connectorRequiredStore';
import ipcService from '../../../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';

/** MCP → 既有 reauthorizeServer；CLI → 设置页「连接」同款的连接器域 oauthConnect。 */
async function reconnectConnector(entry: ConnectorRequiredEntry): Promise<void> {
  const store = useConnectorRequiredStore.getState();
  store.setReauth(entry.sessionId, entry.connectorId, { state: 'running' });
  try {
    if (entry.lostCode === 'mcp_oauth_authorization_required') {
      const result = await ipcService.invokeDomain<{ success: boolean; error?: string }>(IPC_DOMAINS.MCP, 'reauthorizeServer', {
        serverName: entry.connectorId,
      });
      store.setReauth(entry.sessionId, entry.connectorId, result?.success ? { state: 'done' } : { state: 'failed', error: result?.error });
      return;
    }
    await ipcService.invokeDomain<unknown>(IPC_DOMAINS.CONNECTOR, 'oauthConnect', { providerId: entry.connectorId });
    store.setReauth(entry.sessionId, entry.connectorId, { state: 'done' });
  } catch (error) {
    store.setReauth(entry.sessionId, entry.connectorId, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
}

export function LostLoginCard({ entry, name }: { entry: ConnectorRequiredEntry; name: string }): React.ReactElement {
  const { t } = useI18n();
  const state = entry.reauth?.state;
  const error = entry.reauth?.error;
  const reason = entry.lostCode === 'cli_not_logged_in'
    ? t.connectorRequired.lostReasonNotLoggedIn
    : entry.lostCode === 'cli_missing_configuration'
      ? t.connectorRequired.lostReasonMissingConfig
      : entry.lostCode === 'mcp_oauth_authorization_required'
        ? t.connectorRequired.lostReasonAuthorization
        : undefined;
  return (
    <div data-testid={`connector-required-card-${entry.connectorId}`} className="mx-4 mb-2 flex items-center justify-between gap-3 rounded-lg border border-border-muted bg-surface-subtle px-3 py-2 text-sm text-zinc-300">
      <span className="min-w-0">
        <span className="block">{interpolate(state === 'done' ? t.connectorRequired.reconnected : t.connectorRequired.lostTitle, { name })}</span>
        {state === 'running' && <span className="block text-xs text-zinc-500">{t.connectorRequired.reconnecting}</span>}
        {state === 'failed' && <span data-testid="connector-required-reauth-error" className="block text-xs text-badge-danger">{t.connectorRequired.reconnectFailed + (error && /[\u4e00-\u9fff]/.test(error) ? `：${error}` : '')}</span>}
        {reason && state !== 'done' && state !== 'running' && <span className="block text-xs text-zinc-500">{reason}</span>}
      </span>
      <span className="flex shrink-0 gap-2">
        {state === 'done' ? (
          <Button type="button" variant="ghost" size="sm" data-testid="connector-required-dismiss" onClick={() => useConnectorRequiredStore.getState().resolve(entry.sessionId, entry.connectorId)}>{t.connectorRequired.dismiss}</Button>
        ) : (
          <>
            <Button type="button" variant="ghost" size="sm" data-testid="connector-required-later" onClick={() => useConnectorRequiredStore.getState().dismiss(entry.sessionId, entry.connectorId)}>{t.connectorRequired.later}</Button>
            <Button type="button" variant="secondary" size="sm" data-testid="connector-required-reconnect" disabled={state === 'running'} onClick={() => { void reconnectConnector(entry); }}>{t.connectorRequired.reconnect}</Button>
          </>
        )}
      </span>
    </div>
  );
}
