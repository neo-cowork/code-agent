// ============================================================================
// Admin Guard - shared IPC access checks for admin-only surfaces
// ============================================================================

import type { IPCResponse } from '../../shared/ipc';
import { shouldRefusePackagedDevMode } from '../../shared/security/packagedDevModeGuard';
import { getAuthService } from '../services/auth';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('AdminGuard');

export class AdminAccessError extends Error {
  readonly code = 'FORBIDDEN';

  constructor(surface = 'Admin') {
    super(`${surface}: Admin permission required`);
    this.name = 'AdminAccessError';
  }
}

function isLocalWebAdminTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return !shouldRefusePackagedDevMode(env)
    && env.CODE_AGENT_WEB_MODE === 'true'
    && (env.CODE_AGENT_E2E === '1' || env.CODE_AGENT_ENABLE_DEV_API === 'true');
}

export function isCurrentUserAdmin(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isLocalWebAdminTestMode(env)) return true;

  const authService = getAuthService();
  return authService.getCurrentUser()?.isAdmin === true
    && authService.hasVerifiedSession?.() === true;
}

export function assertAdminAccess(surface?: string): void {
  if (!isCurrentUserAdmin()) {
    throw new AdminAccessError(surface);
  }
}

export function getAdminAccessIpcError(surface?: string): IPCResponse | null {
  if (isCurrentUserAdmin()) return null;
  const error = new AdminAccessError(surface);
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
    },
  };
}

/**
 * 提档类入口专用（开启完全访问）：缓存里有管理员声明但会话未验证时，先重校验一次再判定，
 * 区分「确认非管理员」(FORBIDDEN) 与「账号资料暂时没取到」(ADMIN_VERIFICATION_PENDING)。
 */
export async function ensureAdminAccessIpcError(surface?: string): Promise<IPCResponse | null> {
  if (isCurrentUserAdmin()) return null;

  const authService = getAuthService();
  const user = authService.getCurrentUser();
  const trust = authService.getSessionTrustState?.();
  const hasCachedAdminClaim = user?.isAdmin === true && authService.hasVerifiedSession?.() !== true;

  if (!hasCachedAdminClaim) {
    logger.warn('Admin access refused: not an admin', {
      surface, trust, hasUser: user !== null && user !== undefined, hasCachedAdminClaim,
    });
    return getAdminAccessIpcError(surface);
  }

  let outcome: string;
  try {
    outcome = (await authService.revalidateSession?.()) ?? 'unavailable';
  } catch (error) {
    outcome = 'threw';
    logger.warn('Admin session revalidation threw', { surface, error });
  }
  if (isCurrentUserAdmin()) return null;

  const trustAfter = authService.getSessionTrustState?.();
  const adminAfter = authService.getCurrentUser()?.isAdmin === true;
  if (authService.hasVerifiedSession?.() === true || !adminAfter) {
    logger.warn('Admin access refused: not an admin after revalidation', {
      surface, trust, trustAfter, hasCachedAdminClaim, revalidate: outcome,
    });
    return getAdminAccessIpcError(surface);
  }
  logger.warn('Admin access pending: session still unverified after revalidation', {
    surface, trust, trustAfter, hasCachedAdminClaim, revalidate: outcome,
  });
  return {
    success: false,
    error: {
      code: 'ADMIN_VERIFICATION_PENDING',
      message: `${surface ?? 'Admin'}: 账号资料暂时没取到，请稍后重试`,
    },
  };
}
