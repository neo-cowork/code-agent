import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../services/infra/logger';
import { resolveBackgroundRunSettlement, settleBackgroundRun, type BackgroundRunSettlementInput } from './backgroundRunSettlement';
import type { getBackgroundTaskManager } from './backgroundTaskManager';

const logger = createLogger('BackgroundSettlementHold');
type SettlementManager = Pick<ReturnType<typeof getBackgroundTaskManager>, 'isTaskRunning' | 'markCompleted' | 'markFailed'>;
type Completion = { summary?: string; duration?: number };
type Outcome = { manager: SettlementManager; input: BackgroundRunSettlementInput; completion?: Completion };
type Child = { id: string; sessionId: string; parentRunId?: string; leftoverPaths?: readonly string[] };

const executingPrimaryRun = new AsyncLocalStorage<{ sessionId: string; runId: string; active: boolean }>();
const latestRunBySession = new Map<string, string>();
const holdsBySession = new Map<string, Map<string, Outcome>>();
const completionsByRun = new Map<string, { manager: SettlementManager; completion: Completion }>();
const childrenBySession = new Map<string, Map<string, Child>>();
const childLeftoversByRun = new Map<string, string[]>();

function mergeLeftoverPaths(a?: readonly string[], b?: readonly string[]): string[] | undefined {
  if (!a?.length && !b?.length) return undefined;
  const merged = new Set<string>();
  for (const p of a ?? []) merged.add(p);
  for (const p of b ?? []) merged.add(p);
  return [...merged];
}

function inFlightChildren(sessionId: string, runId?: string): number {
  let count = 0;
  for (const child of childrenBySession.get(sessionId)?.values() ?? []) {
    // Older callers without a parent id count against the session's latest primary run.
    if (!child.parentRunId || child.parentRunId === runId) count++;
  }
  return count;
}

export function hasInFlightBackgroundChildren(sessionId: string, runId?: string): boolean {
  return inFlightChildren(sessionId, runId) > 0;
}

export function backgroundPrimaryRunStarted(sessionId: string, runId: string): void {
  const previous = latestRunBySession.get(sessionId);
  if (previous === runId) return;
  latestRunBySession.set(sessionId, runId);
  if (previous) {
    completionsByRun.delete(previous);
    childLeftoversByRun.delete(previous);
  }
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

function applyOutcome(sessionId: string, { manager, input, completion }: Outcome): Promise<void> {
  const settlement = resolveBackgroundRunSettlement(input);
  const target = completion && input.status === 'completed' ? {
    markFailed: manager.markFailed.bind(manager),
    markCompleted: (id: string) => manager.markCompleted(id, completion.summary, completion.duration),
  } : manager;
  return settleBackgroundRun(target, sessionId, settlement);
}

/** Terminal producers supply their row manager so primary registration stays independent of host services. */
export async function settleOrHoldBackgroundRun(
  manager: SettlementManager,
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
    if (!completionsByRun.has(runId)) completionsByRun.set(runId, { manager, completion });
    return;
  }
  const staged = runId ? completionsByRun.get(runId) : undefined;
  const childLeftovers = runId ? childLeftoversByRun.get(runId) : undefined;
  const mergedLeftovers = mergeLeftoverPaths(input.leftoverPaths, childLeftovers);
  const mergedInput = mergedLeftovers ? { ...input, leftoverPaths: mergedLeftovers } : input;
  const outcome = { manager, input: mergedInput, completion: completion ?? staged?.completion };
  if (runId) completionsByRun.delete(runId);
  if (runId && count > 0) {
    const pending = holds ?? new Map<string, Outcome>();
    pending.set(runId, outcome);
    holdsBySession.set(sessionId, pending);
    logger.info('BACKGROUND_SETTLEMENT_HELD', { sessionId, runId, inFlightChildCount: count });
    return;
  }
  if (runId) childLeftoversByRun.delete(runId);
  await applyOutcome(sessionId, outcome);
}

export function backgroundParentOwnsChildNotice(sessionId: string, childId: string): boolean {
  const child = childrenBySession.get(sessionId)?.get(childId);
  const runId = latestRunBySession.get(sessionId);
  if (!child || !runId || (child.parentRunId && child.parentRunId !== runId)) return false;
  const manager = holdsBySession.get(sessionId)?.get(runId)?.manager ?? completionsByRun.get(runId)?.manager;
  return manager?.isTaskRunning(sessionId) ?? false;
}

/** Returns whether the running background row owns this child's success notice. */
export function backgroundChildSettled({ id, sessionId, parentRunId, leftoverPaths }: Child): boolean {
  const children = childrenBySession.get(sessionId);
  if (!children?.delete(id)) return false;
  if (children.size === 0) childrenBySession.delete(sessionId);
  const latest = latestRunBySession.get(sessionId);
  const runId = parentRunId ?? latest;
  if (!runId || runId !== latest) return false;
  if (leftoverPaths?.length) {
    const merged = mergeLeftoverPaths(childLeftoversByRun.get(runId), leftoverPaths);
    if (merged) childLeftoversByRun.set(runId, merged);
  }
  const holds = holdsBySession.get(sessionId);
  const outcome = holds?.get(runId);
  const manager = outcome?.manager ?? completionsByRun.get(runId)?.manager;
  const background = manager?.isTaskRunning(sessionId) ?? false;
  if (outcome && inFlightChildren(sessionId, runId) === 0) {
    holdsBySession.delete(sessionId);
    const mergedLeftovers = mergeLeftoverPaths(outcome.input.leftoverPaths, childLeftoversByRun.get(runId));
    childLeftoversByRun.delete(runId);
    if (background) {
      const finalOutcome = mergedLeftovers
        ? { ...outcome, input: { ...outcome.input, leftoverPaths: mergedLeftovers } }
        : outcome;
      logger.info('BACKGROUND_SETTLEMENT_RELEASED', { sessionId, runId, inFlightChildCount: 0 });
      void applyOutcome(sessionId, finalOutcome).catch((error: unknown) => {
        logger.warn('Unable to settle completed background run', { sessionId, runId, error: String(error) });
      });
    }
  }
  return background;
}
