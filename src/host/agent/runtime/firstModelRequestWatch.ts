import { AsyncLocalStorage } from 'node:async_hooks';
import { STARTUP_TIMEOUTS } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';

export type FirstModelRequestPhase =
  | 'send_accepted' | 'run_started' | 'hook_initialization' | 'skill_discovery'
  | 'planning_bootstrap' | 'parallel_judgment' | 'user_prompt_hook' | 'session_start_hook'
  | 'recent_conversations' | 'session_recovery' | 'seed_memory' | 'activity_context'
  | 'desktop_context' | 'context_ready' | 'model_decision' | 'provider_queue' | 'provider_dispatch';

interface FirstRequestWait {
  sessionId?: string;
  startedAt: number;
  phaseStartedAt: number;
  phase: FirstModelRequestPhase;
  dispatched: boolean;
  closed: boolean;
  warned: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const activeWait = new AsyncLocalStorage<FirstRequestWait>();
const logger = createLogger('FirstModelRequest');

function warnIfOverdue(wait: FirstRequestWait): void {
  if (wait.closed || wait.dispatched || wait.warned
    || Date.now() - wait.startedAt < STARTUP_TIMEOUTS.FIRST_MODEL_REQUEST_WARN_MS) return;
  wait.warned = true;
  logger.warn('First model request delayed', {
    sessionId: wait.sessionId,
    phase: wait.phase,
    elapsedMs: Date.now() - wait.startedAt,
    phaseElapsedMs: Date.now() - wait.phaseStartedAt,
  });
}

/** Shared by HTTP admission and the runtime fallback for CLI/desktop/channel callers. */
export async function watchFirstModelRequest<T>(
  sessionId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const parent = activeWait.getStore();
  if (parent && !parent.closed) {
    parent.sessionId ??= sessionId;
    return run();
  }
  const wait: FirstRequestWait = {
    sessionId, startedAt: Date.now(), phaseStartedAt: Date.now(),
    phase: 'send_accepted', dispatched: false, closed: false, warned: false,
  };
  return activeWait.run(wait, async () => {
    wait.timer = setTimeout(() => warnIfOverdue(wait), STARTUP_TIMEOUTS.FIRST_MODEL_REQUEST_WARN_MS);
    wait.timer.unref?.();
    logger.info('First model request phase', { sessionId, phase: wait.phase, elapsedMs: 0 });
    try {
      return await run();
    } finally {
      // Also inspect elapsed time after synchronous work that starved the timer.
      warnIfOverdue(wait);
      wait.closed = true;
      clearTimeout(wait.timer);
    }
  });
}

export function noteFirstModelRequestPhase(phase: FirstModelRequestPhase, onlyAfter?: FirstModelRequestPhase): void {
  const wait = activeWait.getStore();
  if (!wait || wait.closed || wait.dispatched || wait.phase === phase) return;
  if (onlyAfter && wait.phase !== onlyAfter) return;
  if (phase === 'provider_queue' && wait.phase !== 'provider_dispatch') return;
  warnIfOverdue(wait);
  logger.info('First model request phase', {
    sessionId: wait.sessionId, phase, previousPhase: wait.phase,
    elapsedMs: Date.now() - wait.startedAt,
    previousPhaseElapsedMs: Date.now() - wait.phaseStartedAt,
  });
  wait.phase = phase;
  wait.phaseStartedAt = Date.now();
}

/** Only a transport reached after the main-loop decision ends this wait.
 * Auxiliary preprocessing requests (parallel judgment / memory) must not end it.
 */
export function noteFirstModelRequestDispatched(provider?: string): void {
  const wait = activeWait.getStore();
  if (!wait || wait.closed || wait.dispatched
    || !['provider_queue', 'provider_dispatch'].includes(wait.phase)) return;
  warnIfOverdue(wait);
  wait.dispatched = true;
  clearTimeout(wait.timer);
  logger.info('First model request dispatched', {
    sessionId: wait.sessionId, provider, phase: wait.phase,
    elapsedMs: Date.now() - wait.startedAt,
    phaseElapsedMs: Date.now() - wait.phaseStartedAt,
  });
}
