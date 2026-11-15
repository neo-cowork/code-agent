// 「会话对当前 owner 不可读写」（登录恢复窗口 / 会话归属别的账号）时，写路径收口用的有界重试小件。
//
// 与 foregroundWake 的 owner 重试（deferUntilSessionAccessible）共用同一组界
// （BACKGROUND_WAKE_OWNER_RETRY_*）和同一个登录态信号（authService.addAuthChangeCallback），
// 但不共用它的 PendingWake 状态机：那台机器与唤醒轮的 defer/flush 语义绑死，抽出来
// 共用等于改 foregroundWake 自身（本单明确不动它）。这里只做一件事：一个会因
// 「Session X not found」失败的动作，按同一组界在定时器 + 登录态信号上重试。
import {
  BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS,
  BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS,
} from '../../../shared/constants/sessionCommandCenter';
import { getAuthService } from '../auth/authService';
import { createLogger } from '../infra/logger';

const logger = createLogger('SessionAccessRetry');

export type SessionAccessRetryOutcome = 'written' | 'exhausted' | 'fatal';

export interface SessionAccessRetryInput {
  /** 日志里区分是哪条写路径在等（如 terminal_projection / interruption_message）。 */
  reasonKey: string;
  /** 已经失败过的尝试次数（首次同步尝试由调用方完成）；总尝试数含首次、封顶 MAX_ATTEMPTS。 */
  attemptsUsed?: number;
  /** 要重试的动作；抛错且判为「会话不可达」→ 再等一轮，其他错误视为致命、不再重试。 */
  attempt: () => Promise<void>;
  /** 不可达重试耗尽后调用一次（写人话句 / 保留标记等收尾在这里做）。 */
  onExhausted?: () => void | Promise<void>;
  /** 重试落定后调用一次：written=写成了 / exhausted=耗尽 / fatal=不可归类错误。 */
  onSettled?: (outcome: SessionAccessRetryOutcome) => void;
  /** 并进每条 warn 的定位字段（sessionId/taskId 等）。 */
  logContext?: Record<string, unknown>;
  logger?: { warn(message: string, details?: unknown): void };
}

/** assertAccessibleSession 抛的形状：会话对当前 owner 读不到（登录恢复中或归属他人）。 */
export function isSessionNotAccessibleError(error: unknown): boolean {
  return error instanceof Error && /^Session .+ not found$/.test(error.message);
}

function ownerSignedIn(): boolean {
  try {
    return getAuthService().getCurrentUser() !== null;
  } catch {
    return false;
  }
}

export interface SessionAccessRetry {
  /** 开始等下一轮（定时器 + 登录态信号），不立刻重试。 */
  start(): void;
}

export function createSessionAccessRetry(input: SessionAccessRetryInput): SessionAccessRetry {
  const log = input.logger ?? logger;
  let attempts = input.attemptsUsed ?? 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeAuth: (() => void) | null = null;
  let settled = false;
  let inFlight = false;

  const cleanup = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (unsubscribeAuth) {
      unsubscribeAuth();
      unsubscribeAuth = null;
    }
  };

  const armTimer = (): void => {
    if (timer !== null || settled) return;
    timer = setTimeout(() => {
      timer = null;
      void runAttempt();
    }, BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS);
  };

  const subscribeAuthSignal = (): void => {
    if (unsubscribeAuth || settled) return;
    try {
      unsubscribeAuth = getAuthService().addAuthChangeCallback((user) => {
        if (!user) return;
        void runAttempt();
      });
    } catch (error) {
      log.warn(`${input.reasonKey}: auth signal unavailable; timer retry only`, {
        reason: `${input.reasonKey}_auth_signal_unavailable`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const runAttempt = async (): Promise<void> => {
    if (settled || inFlight) return;
    inFlight = true;
    let outcome: SessionAccessRetryOutcome | null = null;
    try {
      attempts += 1;
      await input.attempt();
      outcome = 'written';
    } catch (error) {
      if (!isSessionNotAccessibleError(error)) {
        log.warn(`${input.reasonKey}: failed with a non-accessibility error; not retrying`, {
          ...input.logContext,
          reason: `${input.reasonKey}_fatal_error`,
          attempts,
          message: error instanceof Error ? error.message : String(error),
        });
        outcome = 'fatal';
      } else if (attempts >= BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS) {
        log.warn(`${input.reasonKey}: session not accessible for current owner after retries; giving up`, {
          ...input.logContext,
          reason: `${input.reasonKey}_not_accessible_retries_exhausted`,
          attempts,
          ownerSignedIn: ownerSignedIn(),
        });
        outcome = 'exhausted';
      } else {
        log.warn(`${input.reasonKey}: session not accessible for current owner; will retry`, {
          ...input.logContext,
          reason: `${input.reasonKey}_not_accessible_for_current_owner`,
          attempts,
          ownerSignedIn: ownerSignedIn(),
        });
      }
    } finally {
      inFlight = false;
    }
    if (outcome === null) {
      armTimer();
      subscribeAuthSignal();
      return;
    }
    settled = true;
    cleanup();
    if (outcome === 'exhausted') {
      try {
        await input.onExhausted?.();
      } catch (error) {
        log.warn(`${input.reasonKey}: exhausted callback failed`, {
          ...input.logContext,
          reason: `${input.reasonKey}_exhausted_callback_failed`,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    input.onSettled?.(outcome);
  };

  return {
    start: () => {
      armTimer();
      subscribeAuthSignal();
    },
  };
}
