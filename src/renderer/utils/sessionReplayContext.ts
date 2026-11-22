import type { Task } from '@shared/contract/backgroundTask';
import type { ScriptRunSnapshot } from '@shared/contract/scriptRun';
import {
  buildSessionReplayEvidenceMap,
  type SessionReplayEvidence,
} from './sessionReplayEvidence';
import { isShellBackgroundTask } from './agentFailureCopy';

export interface SessionReplayContext {
  workflowRuns: ScriptRunSnapshot[];
  backgroundTasks: Task[];
  evidence: SessionReplayEvidence[];
}

export function sessionReplayBackgroundTasks(tasks: Task[], sessionId: string): Task[] {
  return tasks.filter((task) => task.sessionId === sessionId).map((task) =>
    isShellBackgroundTask(task)
      ? { ...task, outputRefs: task.outputRefs.filter((ref) => ref.type !== 'log') }
      : task);
}

export function buildSessionReplayContext(
  sessionId: string | null | undefined,
  workflowRunsById: Record<string, ScriptRunSnapshot>,
  backgroundTasks: Task[],
): SessionReplayContext {
  if (!sessionId) {
    return {
      workflowRuns: [],
      backgroundTasks: [],
      evidence: [],
    };
  }

  return {
    workflowRuns: Object.values(workflowRunsById).filter((run) => run.sessionId === sessionId),
    backgroundTasks: sessionReplayBackgroundTasks(backgroundTasks, sessionId),
    evidence: buildSessionReplayEvidenceMap(workflowRunsById, backgroundTasks).get(sessionId) ?? [],
  };
}
