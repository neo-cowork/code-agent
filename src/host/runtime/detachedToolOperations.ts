import type { PendingOperation, RunEnvelope } from '../../shared/contract/durableRun';
import type { DurableCheckpointInput } from './durableRunKernel';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DetachedToolOperations');

type SettleCheckpoint = Omit<DurableCheckpointInput, 'runId' | 'attempt' | 'owner' | 'state'>;

/**
 * A turn only completes after it has awaited its own tool calls, so a tool_call operation still open at
 * completion belongs to helper work that outlives the turn (a background helper's Read runs under the
 * parent's run id). Close those as abandoned — the late `complete()` is already skipped once the owner ended —
 * instead of letting assertRunEnvelope turn a finished reply into a failed run with a red "运行失败" card.
 */
export async function settleDetachedToolOperations(
  envelope: RunEnvelope | undefined,
  checkpoint: (input: SettleCheckpoint) => Promise<unknown>,
): Promise<void> {
  if (!envelope) return;
  const now = Date.now();
  const abandonedIds: string[] = [];
  const pendingOperations: PendingOperation[] = (envelope.pendingOperations ?? []).map((operation) => {
    if (operation.kind !== 'tool_call' || (operation.status !== 'prepared' && operation.status !== 'dispatched')) return operation;
    abandonedIds.push(operation.operationId);
    return { ...operation, status: 'abandoned' as const, resultRef: `detached-tool:${operation.operationId}`, updatedAt: now };
  });
  if (abandonedIds.length === 0) return;
  logger.info('Completing run with detached tool operations still open; abandoning them', {
    runId: envelope.runId, count: abandonedIds.length, reason: 'detached_tool_operation_outlives_turn',
  });
  await checkpoint({
    now, status: 'running', engineCursor: envelope.cursor.engineCursor, pendingOperations, childRuns: envelope.childRuns,
    events: [{ type: 'detached_tool_operations_abandoned', payload: { operationIds: abandonedIds }, recordedAt: now }],
  });
}
