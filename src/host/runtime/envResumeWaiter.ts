import type { Message } from '../../shared/contract';
import type { RunEnvelope } from '../../shared/contract/durableRun';
import { getRunInterruptCause } from '../../shared/contract/durableRun';
import { ENV_RESUME_POLL_INTERVAL_MS, ENV_RESUME_TIMEOUT_MS, OFFLINE_RESUME_POLL_INTERVAL_MS } from '../../shared/constants/envResume';
import { OAUTH_FLOW_TIMEOUT_MS } from '../connectors/oauth/oauthCoordinator';
import { probeOfflineNetwork } from '../permissions/envAssist/probes/offlineProbe';
import { createLogger } from '../services/infra/logger';
import type { RunRegistry } from './runRegistry';

type EnvResumeProbe = () => Promise<'green' | 'red' | 'unavailable'>;
type Block = NonNullable<RunEnvelope['envBlocked']>;
type Continuer = (input: { sessionId: string; runId: string; onResumeStarted?: () => void }) => Promise<unknown>;
export type EnvResumeProbeFactory = (block: Block) => EnvResumeProbe;
const logger = createLogger('EnvResumeWaiter');
let continuer: Continuer | null = null;
let probeFactory: EnvResumeProbeFactory | undefined;
const pendingReclaims = new Map<string, ReturnType<typeof setTimeout>>();
const loops = new Map<string, { poll?: ReturnType<typeof setTimeout>; deadline?: ReturnType<typeof setTimeout> }>();

/** Registered once by the continue route; arming happens on session return (armEnvResumeOnSessionReturn), never at startup recovery. */
export function registerEnvResumeContinuer(next: Continuer | null, probe?: EnvResumeProbeFactory): void {
  continuer = next;
  probeFactory = probe;
}

export function clearEnvResumeWaiter(runId: string): void {
  const reclaim = pendingReclaims.get(runId);
  if (reclaim) clearTimeout(reclaim);
  pendingReclaims.delete(runId);
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
  const active = () => loops.get(input.runId) === loop;
  const stop = (reason: string, error?: unknown) => {
    if (!active()) return;
    clearEnvResumeWaiter(input.runId);
    logger.warn('Environment auto-continue stopped', {
      runId: input.runId, sessionId: input.sessionId, reason,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    });
  };
  const offline = input.envBlocked.class === 'offline' ? input.envBlocked : undefined;
  // login_expired must cover the whole OAuth flow (up to OAUTH_FLOW_TIMEOUT_MS), not the 120 s default (S7).
  const remaining = offline
    ? offline.deadlineAt - Date.now()
    : input.envBlocked.class === 'login_expired' ? OAUTH_FLOW_TIMEOUT_MS : ENV_RESUME_TIMEOUT_MS;
  const interval = offline ? OFFLINE_RESUME_POLL_INTERVAL_MS : ENV_RESUME_POLL_INTERVAL_MS;
  if (remaining <= 0) { stop('timeout'); return; }
  loop.deadline = setTimeout(() => stop('timeout'), remaining);
  loop.deadline.unref?.();
  let probe: EnvResumeProbe;
  try {
    if (!continuer) { stop('continuer_unavailable'); return; }
    if (!probeFactory) { stop('probe_unavailable'); return; }
    probe = probeFactory(input.envBlocked);
  } catch (error) { stop('probe_unavailable', error); return; }
  const poll = async () => {
    try {
      const result = await probe();
      if (!active()) return;
      if (result === 'unavailable') { stop('probe_unavailable'); return; }
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
      loop.poll = setTimeout(() => { void poll(); }, interval);
      loop.poll.unref?.();
    } catch (error) { stop('probe_unavailable', error); }
  };
  // Defer until finalization has unloaded the parked handle.
  loop.poll = setTimeout(() => { void poll(); }, interval);
  loop.poll.unref?.();
}

/** A click after the polling deadline checks the same parked run before entering Continue. */
export async function recheckOfflineRun(sessionId: string, runId: string, registry: RunRegistry): Promise<boolean> {
  const run = registry.findRecoveredWaitingRun({ sessionId });
  const block = run?.runId === runId ? registry.getDurableEnvelope(runId)?.envBlocked : undefined;
  const resume = continuer;
  if (!resume || block?.class !== 'offline' || Date.now() < block.deadlineAt || !await probeOfflineNetwork(block)) return false;
  return new Promise<boolean>((resolve, reject) => {
    const onResumeStarted = () => resolve(true);
    void resume({ sessionId, runId, onResumeStarted }).then(onResumeStarted, (error: unknown) => {
      logger.warn('Offline continuation failed', { runId, sessionId, error });
      reject(error);
    });
  });
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
export function armEnvResumeOnSessionReturn(
  sessionId: string, registry: SessionReturnRunRegistry, entry: string, messages?: readonly Message[],
): void {
  try {
    const latestCard = messages?.findLast(({ metadata }) => metadata?.envAssist?.class === 'offline');
    const notice = latestCard?.metadata?.envAssist;
    const recovered = registry.findRecoveredWaitingRun({ sessionId });
    if (!recovered) {
      // An immediate visit after a crash can precede fenced lease reclaim.
      if (notice?.phase === 'fixing' && (notice.resume.deadlineAt ?? 0) > Date.now() && !pendingReclaims.has(notice.runId)) {
        const timer = setTimeout(() => {
          pendingReclaims.delete(notice.runId);
          armEnvResumeOnSessionReturn(sessionId, registry, entry, latestCard ? [latestCard] : []);
        }, OFFLINE_RESUME_POLL_INTERVAL_MS);
        timer.unref?.();
        pendingReclaims.set(notice.runId, timer);
      }
      return;
    }
    if (loops.has(recovered.runId)) return;
    const envelope = registry.getDurableEnvelope(recovered.runId);
    if (!envelope || getRunInterruptCause(envelope) !== 'env_blocked' || !envelope.envBlocked) return;
    if (envelope.envBlocked.class === 'offline' && envelope.envBlocked.deadlineAt <= Date.now()) return;
    armEnvResumeOnPark({ runId: recovered.runId, sessionId: recovered.sessionId, envBlocked: envelope.envBlocked });
    logger.info('Environment auto-continue armed on session return', { runId: recovered.runId, sessionId: recovered.sessionId, entry });
  } catch (error) {
    logger.warn('Environment auto-continue arming on session return failed', {
      sessionId, entry,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
