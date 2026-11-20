import { AgentFailureCode, inferAgentFailureCode, isAgentFailureCode } from '@shared/contract/agentFailure';
import type { Translations } from '../i18n';
import { agentFailureCopy } from './agentFailureCopy';

/** One parallel helper's real outcome, as spawn_agent reports it in metadata.helperOutcomes. */
export interface HelperOutcome {
  name: string;
  success: boolean;
  failureCode?: string;
}

export function readHelperOutcomes(metadata: unknown): HelperOutcome[] | undefined {
  const raw = (metadata as { helperOutcomes?: unknown } | null | undefined)?.helperOutcomes;
  if (!Array.isArray(raw)) return undefined;
  const outcomes = raw.flatMap((entry): HelperOutcome[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { name, success, failureCode } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || typeof success !== 'boolean') return [];
    return [{ name: name.trim(), success, ...(typeof failureCode === 'string' ? { failureCode } : {}) }];
  });
  return outcomes.length > 0 ? outcomes : undefined;
}

function reasonFor(outcome: HelperOutcome, t: Translations): string {
  const code = isAgentFailureCode(outcome.failureCode)
    ? outcome.failureCode
    : inferAgentFailureCode({ failureCode: outcome.failureCode, defaultCode: AgentFailureCode.Unknown });
  return agentFailureCopy(code, t) ?? t.toolStepHumanize.agentFailureReasons.unknown;
}

/** Row title: who finished and who did not, no reason (the reason line carries it once). */
export function describeHelperOutcomes(outcomes: HelperOutcome[], t: Translations): string | null {
  if (!outcomes.some((outcome) => !outcome.success)) return null;
  const h = t.toolStepHumanize.helperOutcome;
  return outcomes
    .map((outcome) => (outcome.success ? h.done : h.notDoneTitle).replace('{name}', outcome.name))
    .join(h.separator);
}

/** The reason line: one bare reason for a single failed helper, name-attributed when several failed. */
export function describeHelperFailureReasons(outcomes: HelperOutcome[], t: Translations): string | null {
  const failed = outcomes.filter((outcome) => !outcome.success);
  if (failed.length === 0) return null;
  const h = t.toolStepHumanize.helperOutcome;
  if (failed.length === 1) return reasonFor(failed[0], t);
  return failed.map((outcome) => h.notDone.replace('{name}', outcome.name).replace('{reason}', reasonFor(outcome, t))).join(h.separator);
}
