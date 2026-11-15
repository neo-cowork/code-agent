import fs from 'fs';
import { ENV_ASSIST_BRIDGE_TIMEOUT_MS } from '../../../../shared/constants/envAssist';
import { createLogger } from '../../../services/infra/logger';

const BRIDGE_URL_ENV = 'CODE_AGENT_ENV_ASSIST_BRIDGE_URL';
const BRIDGE_TOKEN_ENV = 'CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN';
const HANDSHAKE_FLAG_ENV = 'CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE';
const HANDSHAKE_PREFIX = 'CODE_AGENT_ENV_ASSIST_BRIDGE ';
const HANDSHAKE_MAX_BYTES = 4096;

const logger = createLogger('EnvAssistShellBridge');

export interface ShellBridgeClient {
  post<TResponse>(path: string, body?: Record<string, unknown>): Promise<TResponse>;
}

interface CapturedBridgeEnv {
  rawUrl: string | undefined;
  token: string | undefined;
}

let capturedBridgeEnv: CapturedBridgeEnv | null = null;

/**
 * One-time capture of the desktop shell loopback bridge credentials.
 * Stores the initial values in module-private memory and immediately deletes
 * both variables from process.env before any child process can inherit them.
 */
export function captureShellBridgeEnv(): void {
  if (capturedBridgeEnv === null) {
    if (process.env[HANDSHAKE_FLAG_ENV] === '1') {
      capturedBridgeEnv = readHandshakeFromStdin();
    } else {
      capturedBridgeEnv = {
        rawUrl: process.env[BRIDGE_URL_ENV],
        token: process.env[BRIDGE_TOKEN_ENV],
      };
    }
  }
  delete process.env[HANDSHAKE_FLAG_ENV];
  delete process.env[BRIDGE_URL_ENV];
  delete process.env[BRIDGE_TOKEN_ENV];
}

/**
 * The shell sends `CODE_AGENT_ENV_ASSIST_BRIDGE <url> <token>\n` as the first stdin line so the
 * credentials never sit in env/argv (readable via `ps eww`). Reads byte by byte and stops at the
 * newline so the later stdin EOF watcher is unaffected.
 */
function readHandshakeFromStdin(): CapturedBridgeEnv {
  const invalid = (): CapturedBridgeEnv => {
    logger.warn('env_assist_bridge:handshake_invalid');
    return { rawUrl: undefined, token: undefined };
  };
  const byte = Buffer.alloc(1);
  const bytes: number[] = [];
  try {
    for (;;) {
      if (bytes.length >= HANDSHAKE_MAX_BYTES) return invalid();
      let n: number;
      try {
        n = fs.readSync(0, byte, 0, 1, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue;
        throw error;
      }
      if (n === 0) return invalid();
      if (byte[0] === 0x0a) break;
      bytes.push(byte[0]);
    }
  } catch {
    return invalid();
  }
  const line = Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
  const parts = line.startsWith(HANDSHAKE_PREFIX) ? line.slice(HANDSHAKE_PREFIX.length).split(' ') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return invalid();
  return { rawUrl: parts[0], token: parts[1] };
}

function parseLoopbackOrigin(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) {
      return null;
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function resolveShellBridgeClientFromEnv(
  env?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ShellBridgeClient | null {
  let rawUrl: string | undefined;
  let token: string | undefined;
  if (env === undefined || env === process.env) {
    captureShellBridgeEnv();
    rawUrl = capturedBridgeEnv?.rawUrl?.trim();
    token = capturedBridgeEnv?.token?.trim();
  } else {
    rawUrl = env[BRIDGE_URL_ENV]?.trim();
    token = env[BRIDGE_TOKEN_ENV]?.trim();
  }
  if (platform !== 'darwin') {
    logger.warn('env_assist_bridge:no_shell');
    return null;
  }
  const baseUrl = rawUrl ? parseLoopbackOrigin(rawUrl) : null;
  if (!baseUrl || !token) {
    logger.warn('env_assist_bridge:no_shell');
    return null;
  }

  return {
    async post<TResponse>(path: string, body: Record<string, unknown> = {}): Promise<TResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ENV_ASSIST_BRIDGE_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        const reason = 'env_assist_bridge:bridge_unreachable';
        logger.warn(reason);
        throw new Error(reason);
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 401 || response.status === 403) {
        const reason = 'env_assist_bridge:bridge_auth_rejected';
        logger.warn(reason);
        throw new Error(reason);
      }

      if (!response.ok) {
        const reason = `env_assist_bridge:bridge_http_${response.status}`;
        logger.warn(reason);
        throw new Error(reason);
      }

      try {
        return await response.json() as TResponse;
      } catch {
        const reason = 'env_assist_bridge:bridge_invalid_json';
        logger.warn(reason);
        throw new Error(reason);
      }
    },
  };
}

/** Cards only offer the prompting button when the desktop shell bridge can actually show the system dialog. */
export function canRequestEnvGrant(): boolean {
  return resolveShellBridgeClientFromEnv() !== null;
}
