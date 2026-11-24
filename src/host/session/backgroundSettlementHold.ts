import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../services/infra/logger';
import { resolveBackgroundRunSettlement, settleBackgroundRun, type BackgroundRunSettlementInput } from './backgroundRunSettlement';
import { getBackgroundTaskManager } from './backgroundTaskManager';

const logger = createLogger('BackgroundSettlementHold');
type Completion = { summary?: string; duration?: number };
type Outcome = { input: BackgroundRunSettlementInput; completion?: Completion };
type Child = { id: string; sessionId: string; parentRunId?: string };

const executingPrimaryRun = new AsyncLocalStorage<{ sessionId: string; runId: string; active: boolean }>();
const latestRunBySession = new Map<string, string>();
const holdsBySession = new Map<string, Map<string, Outcome>>();
const completionsByRun = new Map<string, Completion>();
const childrenBySession = new Map<string, Map<string, Child>>();

function inFlightChildren(sessionId: string, runId?: string): number {
  let count = 0;
  for (const child of childrenBySession.get(sessionId)?.values() ?? []) {
    // Older callers without a parent id count against the session's latest primary run.
    if (!child.parentRunId || child.parentRunId === runId) count++;
  }
  return count;
}

export function backgroundPrimaryRunStarted(sessionId: string, runId: string): void {
  const previous = latestRunBySession.get(sessionId);
  if (previous === runId) return;
  latestRunBySession.set(sessionId, runId);
  if (previous) completionsByRun.delete(previous);
  for (const heldRunId of holdsBySession.get(sessionId)?.keys() ?? []) {
    logger.info('BACKGROUND_SETTLEMENT_DROPPED', {
      sessionId, runId: heldRunId, inFlightChildCount: inFlightChildren(sessionId, heldRunId),
    });
  }
  holdsBySession.delete(sessionId);
}

/** TaskManager preflight can fail before a native handle exists. */
export function withBackgroundPrimaryRun<T>(sessionId: string, runId: string, execute: () => Promise<T>): Promise<T> {
  backgroundPrimaryRunStarted(sessionId, runId);
  const run = { sessionId, runId, active: true };
  return executingPrimaryRun.run(run, async () => {
    try {
      return await execute();
    } finally {
      // Detached callbacks can inherit this scope after the parent promise ends.
      run.active = false;
    }
  });
}

export function executingBackgroundPrimaryRunId(sessionId?: string): string | undefined {
  const run = executingPrimaryRun.getStore();
  return run?.active && run.sessionId === sessionId ? run.runId : undefined;
}

export function backgroundChildAdmitted(child: Child): void {
  const children = childrenBySession.get(child.sessionId) ?? new Map<string, Child>();
  children.set(child.id, { id: child.id, sessionId: child.sessionId, parentRunId: child.parentRunId });
  childrenBySession.set(child.sessionId, children);
}

function applyOutcome(sessionId: string, { input, completion }: Outcome): Promise<void> {
  const manager = getBackgroundTaskManager();
  const settlement = resolveBackgroundRunSettlement(input);
  const target = completion && input.status === 'completed' ? {
    markFailed: manager.markFailed.bind(manager),
    markCompleted: (id: string) => manager.markCompleted(id, completion.summary, completion.duration),
  } : manager;
  return settleBackgroundRun(target, sessionId, settlement);
}

/** All background terminal producers use the same run and child fence. */
export async function settleOrHoldBackgroundRun(
  sessionId: string,
  runId: string | undefined,
  input: BackgroundRunSettlementInput,
  completion?: Completion,
): Promise<void> {
  const latest = latestRunBySession.get(sessionId);
  if (latest && runId !== latest) return;
  const holds = holdsBySession.get(sessionId);
  if (runId && holds?.has(runId)) return;
  const count = inFlightChildren(sessionId, runId);
  // The text completion precedes agent_complete on desktop. Preserve its summary
  // for a successful terminal outcome when children prevent the early close.
  if (runId && completion && count > 0) {
    if (!completionsByRun.has(runId)) completionsByRun.set(runId, completion);
    return;
  }
  const outcome = { input, completion: completion ?? (runId ? completionsByRun.get(runId) : undefined) };
  if (runId) completionsByRun.delete(runId);
  if (runId && count > 0) {
    const pending = holds ?? new Map<string, Outcome>();
    pending.set(runId, outcome);
    holdsBySession.set(sessionId, pending);
    logger.info('BACKGROUND_SETTLEMENT_HELD', { sessionId, runId, inFlightChildCount: count });
    return;
  }
  await applyOutcome(sessionId, outcome);
}

export function backgroundParentOwnsChildNotice(sessionId: string, childId: string): boolean {
  const child = childrenBySession.get(sessionId)?.get(childId);
  const runId = latestRunBySession.get(sessionId);
  return Boolean(child && runId && (!child.parentRunId || child.parentRunId === runId)
    && (holdsBySession.get(sessionId)?.has(runId) || completionsByRun.has(runId))
    && getBackgroundTaskManager().isTaskRunning(sessionId));
}

/** Returns whether the running background row owns this child's success notice. */
export function backgroundChildSettled({ id, sessionId, parentRunId }: Child): boolean {
  const children = childrenBySession.get(sessionId);
  if (!children?.delete(id)) return false;
  if (children.size === 0) childrenBySession.delete(sessionId);
  const latest = latestRunBySession.get(sessionId);
  const runId = parentRunId ?? latest;
  if (!runId || runId !== latest) return false;
  const holds = holdsBySession.get(sessionId);
  const outcome = holds?.get(runId);
  if (!outcome && !completionsByRun.has(runId)) return false;
  const background = getBackgroundTaskManager().isTaskRunning(sessionId);
  if (outcome && inFlightChildren(sessionId, runId) === 0) {
    holdsBySession.delete(sessionId);
    if (background) {
      logger.info('BACKGROUND_SETTLEMENT_RELEASED', { sessionId, runId, inFlightChildCount: 0 });
      void applyOutcome(sessionId, outcome).catch((error: unknown) => {
        logger.warn('Unable to settle completed background run', { sessionId, runId, error: String(error) });
      });
    }
  }
  return background;
}
