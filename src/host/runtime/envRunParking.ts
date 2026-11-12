import type { RunKernelAdapter } from './durableRunKernel';
import type { RunRehydrationPlan } from './durableRunStores';
import type { RunOwnerLease } from '../../shared/contract/durableRun';
import type { RunEnvelope } from '../../shared/contract/durableRun';
import type { RunRegistry } from './runRegistry';
import { armEnvResumeOnPark } from './envResumeWaiter';

export interface DurableParkInput {
  now?: number;
  reason?: 'user_stop' | 'quota_wait' | 'env_blocked';
  dueAt?: number;
  envBlocked?: RunEnvelope['envBlocked'];
  /** A failed continue stays manually continuable, without restarting its polling budget. */
  armEnvWaiter?: boolean;
}

export async function parkEnvBlockedRun(registry: RunRegistry, runId: string, input: DurableParkInput): Promise<void> {
  const envelope = registry.getDurableEnvelope(runId);
  if (!envelope) throw new Error(`Durable Run ${runId} is not active`);
  if (!input.envBlocked) throw new Error('env_blocked park requires metadata');
  const now = input.now ?? Date.now();
  await registry.checkpointDurable(runId, {
    now, status: 'waiting', state: registry.getDurableCheckpointState(runId),
    engineCursor: envelope.cursor.engineCursor, pendingOperations: envelope.pendingOperations ?? [],
    childRuns: envelope.childRuns, interruptCause: 'env_blocked', envBlocked: input.envBlocked,
    events: [{ type: 'run_interrupted', payload: { cause: 'env_blocked', envBlocked: input.envBlocked }, recordedAt: now }],
  });
  if (input.armEnvWaiter !== false) armEnvResumeOnPark({ runId, sessionId: envelope.sessionId, envBlocked: input.envBlocked });
}

export async function readEnvContinuationPlan(kernel: RunKernelAdapter, runId: string,
  live: { owner: RunOwnerLease; attempt: number }): Promise<RunRehydrationPlan> {
  if (!kernel.getRehydrationPlan) throw new Error('Durable kernel cannot read a continuation plan');
  const plan = await kernel.getRehydrationPlan(runId);
  if (plan.envelope.owner?.epoch !== live.owner.epoch || plan.envelope.attempt !== live.attempt) throw new Error('Continuation plan owner changed');
  return plan;
}
