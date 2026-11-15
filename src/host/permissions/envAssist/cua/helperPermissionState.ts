import { MCP_TIMEOUTS } from '../../../../shared/constants';
import { createLogger } from '../../../services/infra/logger';
import { CUA_DRIVER_SERVER_NAME } from '../../../mcp/types';

const logger = createLogger('EnvAssistCuaHelper');

/** What the cua helper process itself reports (its TCC identity, not the Tauri shell's). */
export type CuaHelperPermissionState =
  | { status: 'known'; accessibility: boolean | undefined; screenRecording: boolean | undefined }
  | { status: 'unavailable'; reason: string };

/** Never prompts: upstream refuses prompt:true on the agent path, and we never send it. */
const CHECK_PERMISSIONS_ARGS = { prompt: false, probe_direct_capture: false } as const;

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Reads the helper's own permission state over the already-connected MCP session.
 * It never connects the server: starting the helper is what raises the TCC prompts.
 */
export async function readCuaHelperPermissionState(): Promise<CuaHelperPermissionState> {
  const unavailable = (reason: string): CuaHelperPermissionState => {
    const full = `probe_unavailable:cua_helper:${reason}`;
    logger.warn(full);
    return { status: 'unavailable', reason: full };
  };
  try {
    // Lazy: the permissions layer must not statically depend on mcpClient (import cycle).
    const { getMCPClient } = await import('../../../mcp/mcpClient');
    const client = getMCPClient();
    if (client.getServerState(CUA_DRIVER_SERVER_NAME)?.status !== 'connected') return unavailable('not_connected');
    const result = await client.callTool(
      `env-assist-cua-probe:${Date.now()}`, CUA_DRIVER_SERVER_NAME, 'check_permissions',
      { ...CHECK_PERMISSIONS_ARGS }, { timeoutMs: MCP_TIMEOUTS.TOOL_RETRY },
    );
    if (!result.success) return unavailable('tool_failed');
    const structured = result.metadata?.mcpStructuredContent;
    if (!structured || typeof structured !== 'object') return unavailable('no_structured_content');
    const record = structured as Record<string, unknown>;
    const accessibility = flag(record.accessibility);
    const screenRecording = flag(record.screen_recording);
    if (accessibility === undefined && screenRecording === undefined) return unavailable('unexpected_shape');
    return { status: 'known', accessibility, screenRecording };
  } catch {
    return unavailable('call_error');
  }
}
