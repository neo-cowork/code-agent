import type { RunEnvelope } from '../../shared/contract/durableRun';
import { getRunInterruptCause } from '../../shared/contract/durableRun';
import { ENV_RESUME_POLL_INTERVAL_MS, ENV_RESUME_RUNTIME_STALL_MS, ENV_RESUME_TIMEOUT_MS } from '../../shared/constants/envResume';
import { createLogger } from '../services/infra/logger';
import type { RunRegistry } from './runRegistry';

type EnvResumeProbeStatus = 'green' | 'red' | 'unavailable' | 'failed';
/** `progress` (runtime installs): each new value restarts the stall window; `failed` ends the wait without resuming. */
export type EnvResumeProbe = () => Promise<EnvResumeProbeStatus | { status: EnvResumeProbeStatus; progress?: number }>;
type Block = NonNullable<RunEnvelope['envBlocked']>;
type Continuer = (input: { sessionId: string; runId: string }) => Promise<unknown>;
/** `scope` (when the run is known): lets a runtime probe find the card it keeps current. */
export type EnvResumeProbeFactory = (block: Block, scope?: { runId: string; sessionId: string }) => EnvResumeProbe;
/** A runtime install is bounded by lack of progress, not by the fixed window a permission grant gets. */
const progressBounded = (block: Block): boolean => block.class === 'runtime_missing';
const logger = createLogger('EnvResumeWaiter');
let continuer: Continuer | null = null;
let probeFactory: EnvResumeProbeFactory | undefined;
const loops = new Map<string, { poll?: ReturnType<typeof setTimeout>; deadline?: ReturnType<typeof setTimeout> }>();

/** Registered once by the continue route; arming happens on session return (armEnvResumeOnSessionReturn), never at startup recovery. */
export function registerEnvResumeContinuer(next: Continuer | null, probe?: EnvResumeProbeFactory): void {
  continuer = next;
  probeFactory = probe;
}

export function clearEnvResumeWaiter(runId: string): void {
  const loop = loops.get(runId);
  if (loop?.poll) clearTimeout(loop.poll);
  if (loop?.deadline) clearTimeout(loop.deadline);
  loops.delete(runId);
}

/** One sequential probe at a time; an independent deadline also bounds a hung probe. */
export function armEnvResumeOnPark(input: { runId: string; sessionId: string; envBlocked: Block }): void {
  clearEnvResumeWaiter(input.runId);
  const loop: { poll?: ReturnType<typeof setTimeout>; deadline?: ReturnType<typeof setTimeout> } = {};
  loops.set(input.runId, loop);
  const stalled = progressBounded(input.envBlocked);
  const active = () => loops.get(input.runId) === loop;
  const stop = (reason: string, error?: unknown) => {
    if (!active()) return;
    clearEnvResumeWaiter(input.runId);
    logger.warn('Environment auto-continue stopped', {
      runId: input.runId, sessionId: input.sessionId, reason,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    });
  };
  // A permission wait is bounded by one fixed window; a runtime install only by lack of progress (re-armed below on each change).
  const armDeadline = () => {
    if (loop.deadline) clearTimeout(loop.deadline);
    loop.deadline = setTimeout(() => stop(stalled ? 'stalled' : 'timeout'), stalled ? ENV_RESUME_RUNTIME_STALL_MS : ENV_RESUME_TIMEOUT_MS);
    loop.deadline.unref?.();
  };
  armDeadline();
  let probe: EnvResumeProbe;
  try {
    if (!continuer) { stop('continuer_unavailable'); return; }
    if (!probeFactory) { stop('probe_unavailable'); return; }
    probe = probeFactory(input.envBlocked, { runId: input.runId, sessionId: input.sessionId });
  } catch (error) { stop('probe_unavailable', error); return; }
  let lastProgress: number | undefined;
  const poll = async () => {
    try {
      const outcome = await probe();
      if (!active()) return;
      const result = typeof outcome === 'string' ? outcome : outcome.status;
      if (result === 'unavailable') { stop('probe_unavailable'); return; }
      if (result === 'failed') { stop(stalled ? 'runtime_install_failed' : 'failed'); return; }
      if (result === 'red' && stalled && typeof outcome !== 'string' && outcome.progress !== lastProgress) {
        lastProgress = outcome.progress;
        armDeadline();
      }
      if (result === 'green') {
        const fn = continuer;
        if (!fn) { stop('continuer_unavailable'); return; }
        clearEnvResumeWaiter(input.runId);
        try { await fn({ sessionId: input.sessionId, runId: input.runId }); }
        catch (error) {
          logger.warn('Environment auto-continue stopped', {
            runId: input.runId, sessionId: input.sessionId, reason: 'continuer_failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      loop.poll = setTimeout(() => { void poll(); }, ENV_RESUME_POLL_INTERVAL_MS);
      loop.poll.unref?.();
    } catch (error) { stop('probe_unavailable', error); }
  };
  // Defer until finalization has unloaded the parked handle.
  loop.poll = setTimeout(() => { void poll(); }, ENV_RESUME_POLL_INTERVAL_MS);
  loop.poll.unref?.();
}

/** Session-return arming needs only the recovered-run lookup of the full registry. */
export type SessionReturnRunRegistry = Pick<RunRegistry, 'findRecoveredWaitingRun' | 'getDurableEnvelope'>;

/**
 * ADR-090 §7 owner decision B: startup never arms or auto-continues (nobody may be
 * present); arming happens when the user comes back to the session. Session load
 * entries (REST GET /sessions/:id, domain session load) call this fire-and-forget:
 * it never throws — a failure here must not fail the session load. An already active
 * loop for the run is left untouched, so a repeated return adds no second poll and
 * does not extend the ENV_RESUME_TIMEOUT_MS window; a fresh return restarts it.
 */
export function armEnvResumeOnSessionReturn(sessionId: string, registry: SessionReturnRunRegistry, entry: string): void {
  try {
    const recovered = registry.findRecoveredWaitingRun({ sessionId });
    if (!recovered) return;
    if (loops.has(recovered.runId)) return;
    const envelope = registry.getDurableEnvelope(recovered.runId);
    if (!envelope || getRunInterruptCause(envelope) !== 'env_blocked' || !envelope.envBlocked) return;
    armEnvResumeOnPark({ runId: recovered.runId, sessionId: recovered.sessionId, envBlocked: envelope.envBlocked });
    logger.info('Environment auto-continue armed on session return', { runId: recovered.runId, sessionId: recovered.sessionId, entry });
  } catch (error) {
    logger.warn('Environment auto-continue arming on session return failed', {
      sessionId, entry,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
