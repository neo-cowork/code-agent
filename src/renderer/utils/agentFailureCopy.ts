import type { AgentFailureCode } from '@shared/contract/agentFailure';
import type { Translations } from '../i18n';

/** The translation table requires a copy entry for every AgentFailureCode. */
export function agentFailureCopy(code: AgentFailureCode, t: Translations): string | null {
  const copy = {
    ...t.toolStepHumanize.failureCodes,
    ...t.toolStepHumanize.agentFailureReasons,
  } satisfies Record<AgentFailureCode, string>;
  return copy[code] ?? null;
}
