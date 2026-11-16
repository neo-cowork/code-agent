import type { ToolCall } from '../../../shared/contract';
import type { RunEnvelope } from '../../../shared/contract/durableRun';
import { EnvBlockedError } from '../../permissions/envAssist/EnvBlockedError';
import { getConfiguredApplicationRunRegistry } from '../../app/applicationRunRegistry';
import { isQuotaWaitParkableRun } from '../../runtime/quotaWaitParkability';
import { createLogger } from '../../services/infra/logger';

const notes = new Map<string, NonNullable<RunEnvelope['envBlocked']>>();
const logger = createLogger('EnvBlockedTurn');
export function peekEnvBlockedNote(runId: string | undefined): RunEnvelope['envBlocked'] { return runId ? notes.get(runId) : undefined; }
export function clearEnvBlockedNote(runId: string): void { notes.delete(runId); }

export function settleEnvBlockedTool(error: unknown, input: {
  runId?: string; toolCallId: string; markCancelled: () => void;
}): boolean {
  if (!(error instanceof EnvBlockedError)) return false;
  if (!input.runId || error.toolCallId !== input.toolCallId
    || !isQuotaWaitParkableRun(getConfiguredApplicationRunRegistry(), input.runId)) {
    logger.warn('Environment block cannot park this run', { runId: input.runId, reason: 'run_not_parkable_or_call_mismatch' });
    return false;
  }
  // A parallel batch can encounter several blockers; the first owns this park.
  if (!notes.has(input.runId)) notes.set(input.runId, {
    class: error.class, target: error.target, toolCallId: error.toolCallId,
  });
  input.markCancelled();
  return true;
}

/** Keep dispatched operations open for native recovery; close only unstarted calls. */
export function envBlockedCancelledClosures(runId: string | undefined, toolCalls: ToolCall[]): ToolCall[] {
  if (!runId || !notes.has(runId)) return toolCalls;
  const operations = getConfiguredApplicationRunRegistry()?.getDurableEnvelope(runId)?.pendingOperations ?? [];
  return toolCalls.filter((call) => !operations.some((op) => op.operationId === `tool:${call.id}`
    && !['succeeded', 'failed', 'abandoned'].includes(op.status)));
}

/**
 * A refused Apple-events read on a parkable run parks (EnvBlockedError) instead of failing, so the
 * S3 waiter can replay the same tool call once the grant lands. Non-parkable runs (sub-agents,
 * non-durable hosts) keep the ordinary failure and its card + model guidance.
 * ponytail: calendar (read-only, replay-safe) only; mail/reminders writes wait for N-ENV-ASSIST-S3-RESUME-REST2.
 */
export function envBlockForToolFailure(input: {
  toolName: string; code: unknown; runId?: string; toolCallId?: string;
}): EnvBlockedError | null {
  if (input.toolName !== 'calendar' || input.code !== 'not_authorized' || !input.toolCallId) return null;
  if (!isQuotaWaitParkableRun(getConfiguredApplicationRunRegistry(), input.runId)) return null;
  return new EnvBlockedError('perm_automation', 'calendar', input.toolCallId);
}
