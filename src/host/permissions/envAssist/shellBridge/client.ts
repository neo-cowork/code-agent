import { ENV_ASSIST_BRIDGE_TIMEOUT_MS } from '../../../../shared/constants/envAssist';
import { createLogger } from '../../../services/infra/logger';

const BRIDGE_URL_ENV = 'CODE_AGENT_ENV_ASSIST_BRIDGE_URL';
const BRIDGE_TOKEN_ENV = 'CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN';

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
function captureShellBridgeEnvImpl(): void {
  if (capturedBridgeEnv === null) {
    capturedBridgeEnv = {
      rawUrl: process.env[BRIDGE_URL_ENV],
      token: process.env[BRIDGE_TOKEN_ENV],
    };
  }
  delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL;
  delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN;
}

export const captureShellBridgeEnv = Object.assign(captureShellBridgeEnvImpl, {
  resetForTest(): void {
    capturedBridgeEnv = null;
  },
});

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
