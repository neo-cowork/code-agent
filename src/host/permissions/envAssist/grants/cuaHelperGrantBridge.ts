import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CUA_HELPER_APP_NAMES } from '../../../../shared/cuaHelperChannel';
import { createLogger } from '../../../services/infra/logger';
import { CUA_DRIVER_SERVER_NAME, isStdioConfig } from '../../../mcp/types';

const logger = createLogger('EnvAssistCuaHelperGrant');

/** One click = one call. The helper, not the Tauri shell, must be the process that asks macOS. */
export interface CuaHelperGrantBridge {
  requestHelperGrant(): Promise<void>;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim()))));
}

/** Helper bundle URL from the connected server's launcher path; never an app name. */
async function resolveHelperAppDir(): Promise<string | null> {
  const { getMCPClient } = await import('../../../mcp/mcpClient');
  const config = getMCPClient().getServerState(CUA_DRIVER_SERVER_NAME)?.config;
  if (!config || !isStdioConfig(config)) return null;
  // <App>.app/Contents/Resources/agent-neo-computer-use-mcp.sh
  const appDir = path.resolve(path.dirname(config.command), '..', '..');
  return CUA_HELPER_APP_NAMES.includes(path.basename(appDir)) ? appDir : null;
}

/**
 * Mirrors the launch in scripts/lib/agent-neo-computer-use-mcp.sh: the bundle is opened by
 * URL (so macOS attributes the dialog to the helper) and its own `serve` startup gate raises
 * the prompt when a grant is missing. No `-n`: a live daemon is only re-activated, never
 * duplicated. Never the upstream `permissions grant` CLI and never MCP prompt:true.
 */
export function createCuaHelperGrantBridge(): CuaHelperGrantBridge {
  return {
    async requestHelperGrant(): Promise<void> {
      const appDir = await resolveHelperAppDir();
      if (!appDir) {
        logger.warn('grant_unavailable:cua_helper:no_helper_bundle');
        throw new Error('env_assist_bridge:cua_helper_bundle_missing');
      }
      const bundleId = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(appDir, 'Contents', 'Info.plist')]);
      if (!bundleId) throw new Error('env_assist_bridge:cua_helper_bundle_id_missing');
      const socket = path.join(process.env.TMPDIR || tmpdir(), bundleId, 'cua-driver.sock');
      await run('/usr/bin/open', ['-g', appDir, '--args', 'serve', '--socket', socket, '--host-bundle-id', bundleId]);
    },
  };
}
