import { BACKGROUND_TASK_DELETE_INCOMPLETE } from '@shared/constants';
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

const INTERNAL_AGENT_DETAIL = /^[ \t]*(?:Tool (?:results:|[\w-]+:)|(?:\w*Error|\w*Exception|HTTP)[: ]|Calling \S+\(|\[cwd:|Max iterations reached|Subagent failed|The sub-agent could not produce a result:|(?:Permission denied|Access denied|Operation not permitted)(?:[:.]|$)|(?:EACCES|EPERM|ENOENT|ECONNRESET|ETIMEDOUT)\b)/im;

function readableAgentDetail(text: string | undefined): string | undefined {
  const value = text?.trim();
  return value && !isAgentFailureCode(value.toLowerCase()) && !INTERNAL_AGENT_DETAIL.test(value) ? text : undefined;
}

/** A rehydrated context can end with tool output, so only its explicit failure fact is safe to use. */
export function agentFailureReason(node: AgentTreeNode, t: Translations): string {
  const liveProgress = node.sources.includes('backgroundRegistry') && !node.sources.includes('subagentContext')
    ? node.progress : undefined;
  const plainReason = readableAgentDetail(node.failureReason || liveProgress);
  const code = node.failureCode
    ?? (!plainReason ? AgentFailureCode.Unknown : undefined);
  return agentFailureCopy(code, t, plainReason) ?? t.toolStepHumanize.agentFailureReasons.unknown;
}

export function agentOutputAfterFailure(node: AgentTreeNode, t: Translations, ledgerOutput?: string): string {
  const reason = agentFailureReason(node, t);
  const progress = node.progress?.trim() === node.task?.trim() ? undefined : node.progress;
  const failureDetails = [node.failureReason?.trim(), reason.trim()];
  const output = [ledgerOutput, progress].map(readableAgentDetail)
    .find((text) => text && !failureDetails.includes(text.trim()));
  return output ? `${reason}\n\n${output}` : reason;
}

/** Session-work recovery has its own stable reason, distinct from parent-gone. */
export function backgroundTaskFailureCopy(task: Task, t: Translations): string | null {
  if (task.failure?.reason === BACKGROUND_TASK_DELETE_INCOMPLETE) return t.outcomeWords['delete-incomplete'].detail.reason;
  if (task.failure?.reason === 'session_command_task_interrupted_by_restart') return t.backgroundPanel.interrupted;
  const shellCopy = shellBackgroundTaskFailureCopy(task, t.backgroundPanel);
  if (shellCopy || isShellBackgroundTask(task)) return shellCopy;
  return agentFailureCopy(isAgentFailureCode(task.failure?.reason) ? task.failure.reason : undefined, t, task.failure?.message || task.summary);
}

export function deleteIncompleteFileNames(paths?: readonly string[]): string | undefined {
  return paths?.length ? paths.map((path) => path.split(/[\\/]/).at(-1)).join(', ') : undefined;
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
