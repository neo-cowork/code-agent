import fs from 'fs';
import { ENV_ASSIST_BRIDGE_TIMEOUT_MS } from '../../../../shared/constants/envAssist';
import { createLogger } from '../../../services/infra/logger';

const BRIDGE_URL_ENV = 'CODE_AGENT_ENV_ASSIST_BRIDGE_URL';
const BRIDGE_TOKEN_ENV = 'CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN';
const HANDSHAKE_FLAG_ENV = 'CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE';
const HANDSHAKE_PREFIX = 'CODE_AGENT_ENV_ASSIST_BRIDGE ';
const HANDSHAKE_MAX_BYTES = 4096;

const logger = createLogger('EnvAssistShellBridge');

/** A non-2xx bridge answer carries the route's machine code when it sent one. */
export function bridgeErrorCode(error: unknown): string | undefined {
  const code = (error as { bridgeError?: unknown } | null)?.bridgeError;
  return typeof code === 'string' ? code : undefined;
}

export interface ShellBridgeClient {
  post<TResponse>(path: string, body?: Record<string, unknown>): Promise<TResponse>;
}

interface CapturedBridgeEnv {
  rawUrl: string | undefined;
  token: string | undefined;
  /** Why the capture produced no credentials (flag missing / stdin EOF / bad line ...); only set on failure. */
  failure?: string;
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
      const rawUrl = process.env[BRIDGE_URL_ENV];
      const token = process.env[BRIDGE_TOKEN_ENV];
      capturedBridgeEnv = { rawUrl, token, ...(rawUrl || token ? {} : { failure: 'handshake_flag_missing' }) };
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
  const invalid = (failure: string): CapturedBridgeEnv => {
    logger.warn('env_assist_bridge:handshake_invalid', { reason: failure });
    return { rawUrl: undefined, token: undefined, failure };
  };
  const byte = Buffer.alloc(1);
  const bytes: number[] = [];
  try {
    for (;;) {
      if (bytes.length >= HANDSHAKE_MAX_BYTES) return invalid('line_too_long');
      let n: number;
      try {
        n = fs.readSync(0, byte, 0, 1, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue;
        throw error;
      }
      if (n === 0) return invalid(bytes.length ? 'stdin_eof_mid_line' : 'stdin_eof');
      if (byte[0] === 0x0a) break;
      bytes.push(byte[0]);
    }
  } catch (error) {
    return invalid(`stdin_read_error:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
  }
  const line = Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
  if (!line.startsWith(HANDSHAKE_PREFIX)) return invalid('bad_prefix');
  const parts = line.slice(HANDSHAKE_PREFIX.length).split(' ');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return invalid('bad_field_count');
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
  const baseUrl = rawUrl ? parseLoopbackOrigin(rawUrl) : null;
  if (platform !== 'darwin' || !baseUrl || !token) {
    // Distinguishable degrade trace: which prerequisite is missing (the bare no_shell line alone cannot tell).
    const reason = platform !== 'darwin' ? 'non_darwin'
      : capturedBridgeEnv?.failure && (env === undefined || env === process.env) ? capturedBridgeEnv.failure
      : !rawUrl ? 'url_missing' : !baseUrl ? 'url_invalid' : 'token_missing';
    logger.warn('env_assist_bridge:no_shell');
    logger.warn('env_assist_bridge:no_shell_reason', { reason });
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

      if (!response.ok) {
        const reason = response.status === 401 || response.status === 403
          ? 'env_assist_bridge:bridge_auth_rejected'
          : `env_assist_bridge:bridge_http_${response.status}`;
        logger.warn(reason);
        // The bridge's own machine code (e.g. calendar_not_authorized, event_not_found), never its detail text.
        const code = await response.json().then((json: { error?: unknown }) => json?.error, () => undefined);
        throw Object.assign(new Error(reason), typeof code === 'string' ? { bridgeError: code } : {});
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
let grantBridgeAvailable: boolean | undefined;
export function canRequestEnvGrant(): boolean {
  // The shell hands credentials over once per process, so the answer never changes; resolve (and warn) once.
  grantBridgeAvailable ??= resolveShellBridgeClientFromEnv() !== null;
  return grantBridgeAvailable;
}
