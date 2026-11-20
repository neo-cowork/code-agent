import type { BashStep, TaskProgress } from '../../shared/contract/backgroundTask';
import { isToolResultNeverExecuted } from '../../shared/toolNeverExecuted';
import { bashStepDescription, extractToolStepTarget } from './toolStepTarget';

type ResultProbe = Parameters<typeof isToolResultNeverExecuted>[0];

/** Record a Bash call as a step (before it runs); returns the step so the outcome can be written back. */
export function pushBashStep(
  steps: BashStep[],
  toolCall: { name: string; arguments?: Record<string, unknown> },
): BashStep | undefined {
  if (toolCall.name !== 'Bash' && toolCall.name !== 'bash') return undefined;
  const description = bashStepDescription(toolCall.name, toolCall.arguments);
  const command = toolCall.arguments?.command;
  const step: BashStep = { ...(description ? { description } : {}), command: typeof command === 'string' ? command.slice(0, 200) : '' };
  steps.push(step);
  return step;
}

/** Persist "never executed" on the step once the tool result is known. */
export function markBashStepOutcome(step: BashStep | undefined, result: ResultProbe): void {
  if (step && isToolResultNeverExecuted(result)) step.notRun = true;
}

/**
 * Task-ledger path: bashSteps are appended from task_progress, which carries no call id, so the tracker
 * links each appended step to the oldest pending Bash call (same command preview) of that task. A skipped /
 * denied tool_call_end marks only the step its own call appended; a call that never produced a step marks nothing.
 * Host-internal, never serialized.
 */
export class BashStepCallTracker {
  private pending: Array<{ key: string; preview: string }> = [];
  private readonly linked = new Map<string, BashStep>();

  noteStart(key: string, rawCommand: string): void {
    this.pending.push({ key, preview: extractToolStepTarget({ command: rawCommand }) ?? '' });
  }

  linkStep(taskPrefix: string, step: BashStep | undefined): void {
    if (!step) return;
    const index = this.pending.findIndex((entry) => entry.key.startsWith(taskPrefix) && entry.preview === step.command);
    if (index < 0) return;
    this.linked.set(this.pending[index].key, step);
    this.pending.splice(index, 1);
  }

  settle(key: string, progress: TaskProgress | undefined, result: ResultProbe): TaskProgress | undefined {
    this.pending = this.pending.filter((entry) => entry.key !== key);
    const step = this.linked.get(key);
    this.linked.delete(key);
    const steps = progress?.bashSteps;
    const index = step && steps ? steps.indexOf(step) : -1;
    if (!progress || !steps || index < 0 || !isToolResultNeverExecuted(result)) return progress;
    return { ...progress, bashSteps: steps.map((item, i) => (i === index ? { ...item, notRun: true as const } : item)) };
  }

  clear(): void {
    this.pending = [];
    this.linked.clear();
  }
}

/** Agent-tree path: pair tool-role results with the Bash call that issued them. */
export function notRunCallIds(
  messages: ReadonlyArray<{ toolResults?: ReadonlyArray<{ toolCallId: string; success: boolean; metadata?: Record<string, unknown> }> }>,
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      if (isToolResultNeverExecuted(result)) ids.add(result.toolCallId);
    }
  }
  return ids;
}

/**
 * The delegated executor keeps no tool-role messages, so its outcome lives only on the context snapshot's
 * bashSteps (the tail of the call sequence, same order). Carry notRun over by tail alignment.
 */
export function alignSnapshotNotRun(steps: BashStep[], snapshotSteps: readonly BashStep[] | undefined): void {
  if (!snapshotSteps?.length) return;
  const offset = steps.length - snapshotSteps.length;
  snapshotSteps.forEach((snap, index) => {
    const step = steps[offset + index];
    if (snap.notRun && step && step.description === snap.description && !step.notRun) step.notRun = true;
  });
}
