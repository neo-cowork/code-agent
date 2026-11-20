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

/** Task-ledger path: mark the latest unmarked step for this command text; returns progress unchanged when nothing applies. */
export function markNotRunStepByCommand(
  progress: TaskProgress | undefined,
  rawCommand: string | undefined,
  result: ResultProbe,
): TaskProgress | undefined {
  const steps = progress?.bashSteps;
  if (!progress || !steps || rawCommand === undefined || !isToolResultNeverExecuted(result)) return progress;
  const target = extractToolStepTarget({ command: rawCommand }) ?? '';
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].notRun || steps[i].command !== target) continue;
    return { ...progress, bashSteps: steps.map((step, index) => (index === i ? { ...step, notRun: true as const } : step)) };
  }
  return progress;
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
