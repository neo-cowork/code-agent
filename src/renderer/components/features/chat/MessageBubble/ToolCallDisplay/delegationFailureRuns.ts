import type { Message, ToolCall } from '@shared/contract';
import { isDelegationTool } from '../../../../../utils/agentActivity';
import type { DelegationPresentation } from './delegationPresentation';

interface Run {
  cause: string;
  latestId: string;
  endedAt: number;
}

/**
 * Consecutive same-cause failed delegations: only the newest keeps the red card.
 * Returns the tool-call ids of the older ones. Render-time projection only; nothing persisted changes.
 * A run resets on a completed delegation, a different/unknown cause, or a successful assistant
 * reply that arrives after the failure (same rule as agentErrorRuns).
 */
export function projectSupersededDelegationFailures(
  messages: readonly Message[],
  derive: (toolCall: ToolCall) => DelegationPresentation | null,
): Set<string> {
  const superseded = new Set<string>();
  let run: Run | undefined;
  for (const message of messages) {
    const successfulReply = message.role === 'assistant' && !message.isMeta
      && !message.metadata?.agentError && !message.metadata?.backgroundTaskPreannounce
      && !message.toolCalls?.length && Boolean(message.content?.trim());
    if (successfulReply && run && message.timestamp > run.endedAt) run = undefined;
    for (const toolCall of message.toolCalls ?? []) {
      if (!isDelegationTool(toolCall.name)) continue;
      const presentation = derive(toolCall);
      if (!presentation) continue;
      if (presentation.state === 'completed') run = undefined;
      else if (presentation.state === 'failed') {
        const cause = presentation.failureCause;
        if (!cause) { run = undefined; continue; }
        const endedAt = presentation.endedAt ?? message.timestamp;
        if (run?.cause === cause) superseded.add(run.latestId);
        run = { cause, latestId: toolCall.id, endedAt };
      }
    }
  }
  return superseded;
}
