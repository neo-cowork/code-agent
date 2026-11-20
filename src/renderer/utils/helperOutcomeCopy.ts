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

/** Per-helper sentence, e.g. 「纪要助手已完成；演示稿助手未完成 — 这次任务做到步数上限，已停下」. */
export function describeHelperOutcomes(outcomes: HelperOutcome[], t: Translations): string | null {
  if (!outcomes.some((outcome) => !outcome.success)) return null;
  const h = t.toolStepHumanize.helperOutcome;
  return outcomes
    .map((outcome) => (outcome.success ? h.done : h.notDone)
      .replace('{name}', outcome.name)
      .replace('{reason}', outcome.success ? '' : reasonFor(outcome, t)))
    .join(h.separator);
}

/** The folded row's reason line: only the helpers that did not finish. */
export function describeHelperFailureReasons(outcomes: HelperOutcome[], t: Translations): string | null {
  const failed = outcomes.filter((outcome) => !outcome.success);
  if (failed.length === 0) return null;
  return Array.from(new Set(failed.map((outcome) => reasonFor(outcome, t)))).join(t.toolStepHumanize.helperOutcome.separator);
}
