import type { Task } from '@shared/contract/backgroundTask';
import { AgentFailureCode, inferAgentFailureCode, isAgentFailureCode } from '@shared/contract/agentFailure';
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

/** Session-work recovery has its own stable reason, distinct from parent-gone. */
export function backgroundTaskFailureCopy(task: Task, t: Translations): string | null {
  if (task.failure?.reason === 'session_command_task_interrupted_by_restart') return t.backgroundPanel.interrupted;
  return agentFailureCopy(isAgentFailureCode(task.failure?.reason) ? task.failure.reason : undefined, t, task.failure?.message || task.summary);
}
