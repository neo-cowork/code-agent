import type { Message, ToolCall } from '@shared/contract';
import { isDelegationTool } from '../../../../../utils/agentActivity';
import type { DelegationPresentation } from './delegationPresentation';
import { failureRunStep, isSuccessfulAssistantReply, type FailureRun } from '../../../../../utils/failureRun';

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
  let run: FailureRun | undefined;
  let endedAt = 0;
  for (const message of messages) {
    if (isSuccessfulAssistantReply(message) && run && message.timestamp > endedAt) {
      run = failureRunStep(run, { type: 'reset' }).run;
    }
    for (const toolCall of message.toolCalls ?? []) {
      if (!isDelegationTool(toolCall.name)) continue;
      const presentation = derive(toolCall);
      if (!presentation) continue;
      if (presentation.state === 'completed') run = failureRunStep(run, { type: 'reset' }).run;
      else if (presentation.state === 'failed') {
        const step = failureRunStep(run, { type: 'failure', cause: presentation.failureCause || undefined, id: toolCall.id });
        if (step.supersededId !== undefined) superseded.add(step.supersededId);
        run = step.run;
        endedAt = presentation.endedAt ?? message.timestamp;
      }
    }
  }
  return superseded;
}
