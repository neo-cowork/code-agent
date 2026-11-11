import { AgentFailureCode, inferAgentFailureCode } from '@shared/contract/agentFailure';
import { languages, type Translations } from '../i18n';
import { agentFailureHostPhrases } from '../i18n/agentFailureHostPhrases';
import { containsCjk } from './containsCjk';

/** The translation table requires a copy entry for every AgentFailureCode. */
export function agentFailureCopy(code: AgentFailureCode | undefined, t: Translations, hostReason?: string): string | null {
  const copy = {
    ...t.toolStepHumanize.failureCodes,
    ...t.toolStepHumanize.agentFailureReasons,
  } satisfies Record<AgentFailureCode, string>;
  if (code) return copy[code] ?? null;
  // useI18n returns these builtin tables. Keep historical Chinese copy byte-for-byte.
  if (t === languages.zh) return hostReason || null;
  const reason = hostReason?.trim() ?? '';
  if (reason && !containsCjk(reason)) return hostReason || null;
  const inferred = Object.hasOwn(agentFailureHostPhrases, reason)
    ? agentFailureHostPhrases[reason]
    : inferAgentFailureCode({ error: reason });
  return copy[inferred];
}
