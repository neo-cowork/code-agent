import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { getToolResolver } from '../../../src/host/tools/dispatch/toolResolver';
import { executePocToolViaProtocol } from '../../../src/host/tools/dispatch/shadowAdapter';
import { getConnectorRegistry } from '../../../src/host/connectors/registry';
import type { ToolContext } from '../../../src/host/tools/types';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }),
}));

const execute = async (path: string, action: string) => {
  const requestPermission = vi.fn(async () => true);
  return path === 'resolver'
    ? getToolResolver().execute('calendar', { action }, {
      workingDirectory: '/tmp', requestPermission, abortSignal: new AbortController().signal,
    } as unknown as ToolContext)
    : executePocToolViaProtocol({ toolName: 'calendar', params: { action }, workingDirectory: '/tmp', requestPermission });
};

describe('connector reconnect guidance through real protocol dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProtocolRegistry();
    getConnectorRegistry().configure([]);
  });

  it.each(['resolver', 'adapter'])('%s preserves missing-connector failure and adds a reconnect exit', async (path) => {
    const result = await execute(path, 'list_events');
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('NOT_INITIALIZED');
    expect(result.error).toContain('Settings > Connectors');
    expect(warn).toHaveBeenCalledWith('Connector call needs reconnection', expect.objectContaining({
      connectorId: 'calendar', reason: 'not-enabled-or-registered',
    }));
    expect(getConnectorRegistry().get('calendar')).toBeUndefined();
  });

  it.each(['resolver', 'adapter'])('%s adds the exit to a disconnected status without inventing authorization', async (path) => {
    const result = await execute(path, 'get_status');
    expect(result.success).toBe(true);
    expect(result.output).toContain('Settings > Connectors');
    expect(result.metadata?.status).toMatchObject({ connected: false, unavailable: true });
    expect(warn).toHaveBeenCalledWith('Connector call needs reconnection', expect.objectContaining({
      connectorId: 'calendar', reason: 'status-not-connected',
    }));
  });
});
