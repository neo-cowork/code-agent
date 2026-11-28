import { findConnectorIdForToolName } from '../../../shared/contract/workbenchTools';
import { isCliConnectorId, updateCliConnectorConnectionStatusCache } from '../../connectors/cli/cliConnectorStatusCache';
import { readDevCliConnectorStatusShim } from '../../connectors/cli/devCliConnectorStatusShim';
import { createLarkCliDriver } from '../../connectors/feishu/larkCli';
import { createTmeetCliDriver } from '../../connectors/tmeet/tmeetCli';
import type { MCPClient } from '../../mcp/mcpClient';
import {
  MCP_AUTHORIZATION_REQUIRED_METADATA_KEY,
  MCP_INSUFFICIENT_SCOPE_METADATA_KEY,
} from '../../mcp/mcpErrors';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('EnvAssistLoginRecovery');

export interface LoginExpiredTarget {
  kind: 'mcp' | 'cli';
  target: string;
}

type CliDriver = ReturnType<typeof createLarkCliDriver>;

const cliDrivers = new Map<string, CliDriver>();
const skippedLoginToolCalls = new Set<string>();

function getCliDriver(connectorId: string): CliDriver | undefined {
  let driver = cliDrivers.get(connectorId);
  if (driver) return driver;
  if (connectorId === 'feishu') driver = createLarkCliDriver();
  else if (connectorId === 'tmeet') driver = createTmeetCliDriver();
  if (driver) cliDrivers.set(connectorId, driver);
  return driver;
}

function parseMcpServerPrefix(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const rest = toolName.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  return sep > 0 ? rest.slice(0, sep) : undefined;
}

/** Single classifier shared by classify.ts, toolResolver.ts, and envBlockedTurn.ts. */
export function resolveLoginExpiredTarget(
  toolName: string,
  code: unknown,
  metadata: Record<string, unknown> | undefined,
): LoginExpiredTarget | null {
  if (metadata?.[MCP_AUTHORIZATION_REQUIRED_METADATA_KEY] === true && !metadata[MCP_INSUFFICIENT_SCOPE_METADATA_KEY]) {
    const server = (typeof metadata.serverName === 'string' && metadata.serverName)
      || (typeof metadata.server === 'string' && metadata.server)
      || parseMcpServerPrefix(toolName);
    if (server) return { kind: 'mcp', target: server };
  }
  if (code === 'cli_not_logged_in' || metadata?.lostCode === 'cli_not_logged_in') {
    const connector = (typeof metadata?.connector === 'string' && metadata.connector)
      || findConnectorIdForToolName(toolName);
    if (connector && isCliConnectorId(connector)) {
      return { kind: 'cli', target: connector };
    }
  }
  return null;
}

/**
 * One-shot silent recovery before surfacing a login_expired card:
 * - MCP: reconnect using existing client registration + refresh token (no browser redirect).
 * - CLI: forced status(true) re-probe.
 * Always logs a distinguishable outcome so tests and real runs can prove it ran.
 */
export async function trySilentLoginRecovery(
  input: LoginExpiredTarget,
  deps?: {
    mcpClient?: MCPClient;
    cliDriver?: Pick<CliDriver, 'status'>;
  },
): Promise<{ recovered: boolean; reason?: string }> {
  if (input.kind === 'mcp') {
    const [{ getMCPClient }, { silentReconnectMcpServer }] = await Promise.all([
      import('../../mcp/mcpClient'),
      import('../../mcp/mcpReauthorize'),
    ]);
    const client = deps?.mcpClient ?? getMCPClient();
    const result = await silentReconnectMcpServer(client, input.target);
    if (result.success) {
      logger.info('Login silent recovery succeeded', { kind: 'mcp', connectorId: input.target });
      return { recovered: true };
    }
    const reason = result.reason ?? 'refresh_failed';
    logger.warn('Login silent recovery failed', {
      kind: 'mcp',
      connectorId: input.target,
      reason,
      ...(result.error ? { error: result.error } : {}),
    });
    return { recovered: false, reason };
  }

  const shimmed = readDevCliConnectorStatusShim(input.target);
  if (shimmed) {
    updateCliConnectorConnectionStatusCache({
      id: input.target,
      connected: shimmed.connected,
      ...(shimmed.lostReason ? { lostReason: shimmed.lostReason } : {}),
    });
    if (shimmed.connected) {
      logger.info('Login silent recovery succeeded', { kind: 'cli', connectorId: input.target, source: 'dev_shim' });
      return { recovered: true };
    }
    const reason = shimmed.lostReason ?? 'cli_not_logged_in';
    logger.warn('Login silent recovery failed', { kind: 'cli', connectorId: input.target, reason, source: 'dev_shim' });
    return { recovered: false, reason };
  }

  const driver = deps?.cliDriver ?? getCliDriver(input.target);
  if (!driver) {
    logger.warn('Login silent recovery skipped', { kind: 'cli', connectorId: input.target, reason: 'driver_unavailable' });
    return { recovered: false, reason: 'driver_unavailable' };
  }

  try {
    const status = await driver.status(true);
    if (!status.stale) {
      updateCliConnectorConnectionStatusCache({
        id: input.target,
        connected: status.connected,
        ...(status.lostReason ? { lostReason: status.lostReason } : {}),
      });
    }
    if (status.connected) {
      logger.info('Login silent recovery succeeded', { kind: 'cli', connectorId: input.target });
      return { recovered: true };
    }
    const reason = status.lostReason ?? (status.stale ? 'status_stale' : 'cli_not_logged_in');
    logger.warn('Login silent recovery failed', { kind: 'cli', connectorId: input.target, reason });
    return { recovered: false, reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Login silent recovery failed', { kind: 'cli', connectorId: input.target, reason: 'probe_error', error: message });
    return { recovered: false, reason: 'probe_error' };
  }
}

/** Passive probe used by envResumeProbeFactory and envAssist.recheck for login_expired. */
export async function probeLoginStatus(
  target: string,
  deps?: {
    mcpClient?: Pick<MCPClient, 'getServerState' | 'isConnected'>;
    cliDriver?: Pick<CliDriver, 'status'>;
  },
): Promise<'green' | 'red' | 'unavailable'> {
  if (isCliConnectorId(target)) {
    const shimmed = readDevCliConnectorStatusShim(target);
    if (shimmed) {
      updateCliConnectorConnectionStatusCache({
        id: target,
        connected: shimmed.connected,
        ...(shimmed.lostReason ? { lostReason: shimmed.lostReason } : {}),
      });
      return shimmed.connected ? 'green' : 'red';
    }
    const driver = deps?.cliDriver ?? getCliDriver(target);
    if (!driver) {
      logger.warn('Env resume probe unavailable', { reason: 'cli_driver_unavailable', class: 'login_expired', target });
      return 'unavailable';
    }
    try {
      const status = await driver.status(false);
      if (!status.stale) {
        updateCliConnectorConnectionStatusCache({
          id: target,
          connected: status.connected,
          ...(status.lostReason ? { lostReason: status.lostReason } : {}),
        });
      }
      return status.connected ? 'green' : 'red';
    } catch (error) {
      logger.warn('CLI login probe failed', {
        target,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'red';
    }
  }

  const client = deps?.mcpClient ?? (await import('../../mcp/mcpClient')).getMCPClient();
  if (!client.getServerState(target)) {
    logger.warn('Env resume probe unavailable', { reason: 'mcp_server_not_registered', class: 'login_expired', target });
    return 'unavailable';
  }
  return client.isConnected(target) ? 'green' : 'red';
}

/** Host action triggered when the user clicks "Sign in again" / "Try again" on a login_expired card. */
export async function reauthorizeLoginTarget(
  target: string,
  requiredScope?: string,
  deps?: {
    mcpClient?: MCPClient;
    cliDriver?: Pick<CliDriver, 'connect' | 'status'>;
    openExternal?: (url: string) => Promise<void>;
  },
): Promise<{ success: boolean; error?: string }> {
  if (isCliConnectorId(target)) {
    const shimmed = readDevCliConnectorStatusShim(target);
    if (shimmed?.connected) {
      updateCliConnectorConnectionStatusCache({ id: target, connected: true });
      return { success: true };
    }
    const driver = deps?.cliDriver ?? getCliDriver(target);
    if (!driver) return { success: false, error: `CLI connector "${target}" is unavailable` };
    try {
      const openExternal = deps?.openExternal ?? (await import('../../platform/nativeShell')).openExternal;
      await driver.connect(openExternal);
      const status = await driver.status(true);
      updateCliConnectorConnectionStatusCache({
        id: target,
        connected: status.connected,
        ...(status.lostReason ? { lostReason: status.lostReason } : {}),
      });
      return status.connected
        ? { success: true }
        : { success: false, error: status.lostReason ?? 'sign-in was not completed' };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const [{ getMCPClient }, { reauthorizeMcpServer }] = await Promise.all([
    import('../../mcp/mcpClient'),
    import('../../mcp/mcpReauthorize'),
  ]);
  return await reauthorizeMcpServer(deps?.mcpClient ?? getMCPClient(), target, requiredScope);
}

function skipKey(runId: string, toolCallId: string): string {
  return `${runId}|${toolCallId}`;
}

export function markSkippedLoginToolCall(runId: string, toolCallId: string): void {
  skippedLoginToolCalls.add(skipKey(runId, toolCallId));
}

export function isSkippedLoginToolCall(runId: string, toolCallId: string): boolean {
  return skippedLoginToolCalls.has(skipKey(runId, toolCallId));
}

export function consumeSkippedLoginToolCall(runId: string, toolCallId: string): boolean {
  const key = skipKey(runId, toolCallId);
  if (!skippedLoginToolCalls.has(key)) return false;
  skippedLoginToolCalls.delete(key);
  return true;
}
