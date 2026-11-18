import type { Task } from '@shared/contract/backgroundTask';
import type { ScriptRunSnapshot } from '@shared/contract/scriptRun';
import type { Translations } from '../i18n';
import {
  buildSessionReplayEvidenceMap,
  type SessionReplayEvidence,
} from './sessionReplayEvidence';

export interface SessionReplayContext {
  workflowRuns: ScriptRunSnapshot[];
  backgroundTasks: Task[];
  evidence: SessionReplayEvidence[];
}

export function buildSessionReplayContext(
  sessionId: string | null | undefined,
  workflowRunsById: Record<string, ScriptRunSnapshot>,
  backgroundTasks: Task[],
  t: Translations,
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
    backgroundTasks: backgroundTasks.filter((task) => task.sessionId === sessionId),
    evidence: buildSessionReplayEvidenceMap(workflowRunsById, backgroundTasks, t).get(sessionId) ?? [],
  };
}
