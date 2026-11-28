import { OFFLINE_RESUME_TIMEOUT_MS } from '../../../shared/constants/envResume';
import { classifyError } from '../../model/errorClassifier';
import { resolveProviderBaseUrl } from '../../model/providers/providerResolution';
import { probeOfflineNetwork } from '../../permissions/envAssist/probes/offlineProbe';
import type { AgentEvent, ModelConfig, ToolCall } from '../../../shared/contract';
import type { RunEnvelope } from '../../../shared/contract/durableRun';
import { EnvBlockedError } from '../../permissions/envAssist/EnvBlockedError';
import { getConfiguredApplicationRunRegistry } from '../../app/applicationRunRegistry';
import { isQuotaWaitParkableRun } from '../../runtime/quotaWaitParkability';
import { recordParkedCallApproval } from '../../permissions/parkedCallApproval';
import { createLogger } from '../../services/infra/logger';

import { envBlockedNotes as notes } from './envBlockedNotes';
export { peekEnvBlockedNote, clearEnvBlockedNote } from './envBlockedNotes';
const logger = createLogger('EnvBlockedTurn');

export function settleEnvBlockedTool(error: unknown, input: {
  runId?: string; toolCallId: string; markCancelled: () => void; toolName?: string; args?: unknown; sessionId?: string;
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
  // The user already confirmed this call and it never ran: keep a one-shot credential for the resumed run (parkedCallApproval.ts).
  if (input.toolName && error.approvedCallArgs !== undefined) recordParkedCallApproval({ sessionId: input.sessionId, runId: input.runId, tool: input.toolName, args: error.approvedCallArgs });
  input.markCancelled();
  return true;
}

export async function settleOfflineInference(error: unknown, input: {
  config: ModelConfig; runId?: string; sessionId?: string;
  shouldStop: () => boolean; markCancelled: () => void; onEvent: (event: AgentEvent) => void;
}): Promise<boolean> {
  const kind = classifyError(error);
  if (kind !== 'network' && kind !== 'unavailable') return false;
  const { runId, sessionId, config } = input;
  if (!runId || !sessionId || !isQuotaWaitParkableRun(getConfiguredApplicationRunRegistry(), runId)) return false;
  const endpoint = URL.parse(resolveProviderBaseUrl(config));
  if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol)) return false;
  const target = { endpoint: endpoint.origin, provider: config.provider };
  if (await probeOfflineNetwork(target) || input.shouldStop()) return false;
  const now = Date.now();
  const deadlineAt = now + OFFLINE_RESUME_TIMEOUT_MS;
  notes.set(runId, { class: 'offline', target: 'network', ...target, deadlineAt });
  input.markCancelled();
  logger.info('Network unavailable; parking model inference', { runId, sessionId });
  try {
    const { publishEnvAssistNotice } = await import('../../permissions/envAssist/toolNotice');
    await publishEnvAssistNotice({
      id: `${runId}|offline|network`, sessionId, runId, class: 'offline', phase: 'fixing',
      sentenceKey: 'env.offline.waiting', resume: { mode: 'auto', parkId: runId, deadlineAt }, updatedAt: now,
    }, input.onEvent);
  } catch {
    logger.warn('Could not publish offline notice', { runId, sessionId });
  }
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
 * A refused calendar (EventKit) read or Mail draft write on a parkable run parks (EnvBlockedError) instead of
 * failing. Calendar replays the same call once the grant lands; mail_draft is never replayed in place (the
 * continuation records a "not run" result and the model re-issues it once). Non-parkable runs (sub-agents,
 * non-durable hosts) keep the ordinary failure and its card + model guidance.
 * ponytail: only calendar and mail_draft park; mail_send, reminders, screen and accessibility keep the ordinary failure.
 */
export function envBlockForToolFailure(input: {
  toolName: string; code: unknown; runId?: string; toolCallId?: string;
}): EnvBlockedError | null {
  if (input.code !== 'not_authorized' || !input.toolCallId) return null;
  if (input.toolName !== 'calendar' && input.toolName !== 'mail_draft') return null;
  if (!isQuotaWaitParkableRun(getConfiguredApplicationRunRegistry(), input.runId)) return null;
  return input.toolName === 'calendar'
    ? new EnvBlockedError('perm_calendars', 'calendar', input.toolCallId)
    : new EnvBlockedError('perm_automation', 'mail', input.toolCallId);
}
