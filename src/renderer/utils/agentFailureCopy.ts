import type { AgentTreeNode } from '@shared/contract/agentTree';
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

/** A rehydrated context can end with tool output, so only its explicit failure fact is safe to use. */
export function agentFailureReason(node: AgentTreeNode, t: Translations): string {
  const liveProgress = node.sources.includes('backgroundRegistry') && !node.sources.includes('subagentContext')
    ? node.progress : undefined;
  const reason = node.failureReason || liveProgress;
  const internalReason = /^(?:Tool (?:results:|[\w-]+:)|(?:\w*Error|\w*Exception|HTTP)[: ]|Calling \S+\(|Max iterations reached)/i;
  const plainReason = reason?.trim() && !internalReason.test(reason.trim()) ? reason : undefined;
  const code = node.failureCode
    ?? (!plainReason ? AgentFailureCode.Unknown : undefined);
  return agentFailureCopy(code, t, plainReason) ?? t.toolStepHumanize.agentFailureReasons.unknown;
}

/** Session-work recovery has its own stable reason, distinct from parent-gone. */
export function backgroundTaskFailureCopy(task: Task, t: Translations): string | null {
  if (task.failure?.reason === 'session_command_task_interrupted_by_restart') return t.backgroundPanel.interrupted;
  const shellCopy = shellBackgroundTaskFailureCopy(task, t.backgroundPanel);
  if (shellCopy || isShellBackgroundTask(task)) return shellCopy;
  return agentFailureCopy(isAgentFailureCode(task.failure?.reason) ? task.failure.reason : undefined, t, task.failure?.message || task.summary);
}

export function isShellBackgroundTask(task: Pick<Task, 'source'>): boolean {
  return task.source === 'shell' || task.source === 'pty';
}

export function shellBackgroundTaskFailureCopy(
  task: Task,
  copy: Pick<Translations['backgroundPanel'], 'shellCommandFailed'>,
): string | null {
  if (task.failure?.reason === 'shell_command_failed' || (isShellBackgroundTask(task) && (task.status === 'failed' || task.failure))) {
    return copy.shellCommandFailed;
  }
  return null;
}
