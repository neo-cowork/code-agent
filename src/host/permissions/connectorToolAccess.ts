import type { PermissionRequest } from '../../shared/contract/permission';
import { RECOMMENDED_MCP_SERVERS } from '../../shared/constants/mcpCatalog';

// Only Neo's catalog is authoritative. Server annotations never enter this index.
const declaredConnectors = new Map(RECOMMENDED_MCP_SERVERS
  .filter((entry) => entry.readOnlyTools !== undefined)
  .map((entry) => [entry.id, entry]));
const readOnlyTools: ReadonlySet<string> = new Set([...declaredConnectors.values()]
  .flatMap((entry) => (entry.readOnlyTools ?? []).map(
    (tool) => `mcp__${entry.id}__${tool.replace(/\./g, '_')}`,
  )));

export function isDeclaredReadOnlyConnectorTool(runtimeName: string): boolean {
  return readOnlyTools.has(runtimeName);
}

export function classifyConnectorTool(runtimeName: string): NonNullable<PermissionRequest['details']['connectorAccess']> | null {
  const parsed = /^mcp__(.+?)__(.+)$/.exec(runtimeName);
  if (!parsed) return null;
  const entry = declaredConnectors.get(parsed[1]);
  if (!entry) return null;
  // Registry names retain dots; provider tool names replace them with underscores.
  const canonicalName = `mcp__${entry.id}__${parsed[2].replace(/\./g, '_')}`;
  return {
    connectorId: entry.id,
    connectorName: entry.name,
    access: isDeclaredReadOnlyConnectorTool(canonicalName) ? 'read' : 'write',
  };
}

/** Shared by mint and pre-ask. Writes retain the exact tool + target identity. */
export function connectorToolGrantIdentity(tool: string, target: string | null): { tool: string; target: string | null } | null {
  // This is a storage namespace, never an MCP runtime identity. A plugin tool
  // with the same spelling must neither consume nor mint a connector grant.
  if (tool.startsWith('connector-read:')) return null;
  const access = classifyConnectorTool(tool);
  return access?.access === 'read'
    ? { tool: `connector-read:${access.connectorId}`, target: null }
    : { tool, target };
}

export function connectorReadGrantName(key: string): string | undefined {
  return key.startsWith('connector-read:')
    ? declaredConnectors.get(key.slice('connector-read:'.length))?.name
    : undefined;
}
