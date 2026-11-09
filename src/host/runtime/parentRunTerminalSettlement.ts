import type { RunHandle } from './runContext';
import type { RunEnvelope } from '../../shared/contract/durableRun';
import { BACKGROUND_TASK_CANCELLED } from '../../shared/constants';

/** Successful foreground hand-back leaves detached work running; failure/cancel stops it. */
export async function settleParentRunTerminal(envelope: RunEnvelope, getHandle: (runId: string) => RunHandle | undefined): Promise<void> {
  if (envelope.status !== 'failed' && envelope.status !== 'cancelled') return;
  for (const child of envelope.childRuns ?? []) {
    if (child.status === 'running' || child.status === 'waiting' || child.status === 'paused') {
      await getHandle(child.childRunId)?.cancel();
    }
  }
  const { getSpawnGuard } = await import('../agent/spawnGuard');
  const { getSingleSpawnChildren } = await import('../agent/singleSpawnVisibilityRegistry');
  const guard = getSpawnGuard();
  const scope = { sessionId: envelope.sessionId, runId: envelope.runId };
  guard.cancelRun(scope, 'parent-cancel');
  for (const agent of guard.list({ sessionId: envelope.sessionId })) {
    if (agent.scope?.parentNativeRunId === envelope.runId) guard.cancel(agent.id);
  }
  for (const agentId of getSingleSpawnChildren(scope)) guard.cancel(agentId);
  // A child terminal must not settle the foreground session's panel row.
  if (!envelope.parentRunId) {
    const { getBackgroundTaskManager } = await import('../session/backgroundTaskManager');
    await getBackgroundTaskManager().markCompleted(envelope.sessionId, BACKGROUND_TASK_CANCELLED);
  }
}
