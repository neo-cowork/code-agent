import type { RunHandle } from './runContext';
import type { RunEnvelope } from '../../shared/contract/durableRun';
import { BACKGROUND_TASK_CANCELLED } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ParentRunTerminalSettlement');

/**
 * Successful foreground hand-back leaves detached work running. A FAILED parent (error / step limit) stops
 * foreground helpers only: background children keep running and report when done (owner rule 11-10).
 * A CANCELLED parent (user Stop / explicit cancel) stops everything.
 */
export async function settleParentRunTerminal(envelope: RunEnvelope, getHandle: (runId: string) => RunHandle | undefined): Promise<void> {
  if (envelope.status !== 'failed' && envelope.status !== 'cancelled') return;
  const stopEverything = envelope.status === 'cancelled';
  try {
    const { getSpawnGuard } = await import('../agent/spawnGuard');
    const { getSingleSpawnChildren } = await import('../agent/singleSpawnVisibilityRegistry');
    const guard = getSpawnGuard();
    for (const child of envelope.childRuns ?? []) {
      if (child.status !== 'running' && child.status !== 'waiting' && child.status !== 'paused') continue;
      if (!stopEverything && child.relation === 'agent' && guard.isDetachedWork(child.childRunId)) continue;
      await getHandle(child.childRunId)?.cancel();
    }
    const scope = { sessionId: envelope.sessionId, runId: envelope.runId };
    if (stopEverything) {
      guard.cancelRun(scope, 'parent-cancel');
      for (const agent of guard.list({ sessionId: envelope.sessionId })) {
        if (agent.scope?.parentNativeRunId === envelope.runId) guard.cancel(agent.id);
      }
      for (const agentId of getSingleSpawnChildren(scope)) guard.cancel(agentId);
      guard.settleParentRun(envelope.sessionId, envelope.runId, true);
    } else {
      guard.settleParentRun(envelope.sessionId, envelope.runId, false, getSingleSpawnChildren(scope));
    }
    // A child terminal must not settle the foreground session's panel row. A failed parent is left to the
    // TaskManager rejection path (markFailed with the real error); cancelling it here would show "stopped".
    if (!envelope.parentRunId && envelope.status === 'cancelled') {
      const { getBackgroundTaskManager } = await import('../session/backgroundTaskManager');
      await getBackgroundTaskManager().markCompleted(envelope.sessionId, BACKGROUND_TASK_CANCELLED);
    }
  } catch (error) {
    // Settlement is best-effort: the parent terminal itself must still complete.
    logger.warn('Parent run terminal settlement of spawned work failed', {
      runId: envelope.runId, reason: 'parent_terminal_settlement_failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
