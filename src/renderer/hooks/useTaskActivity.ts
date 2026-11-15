import { useMemo } from 'react';
import type { AgentTreeSnapshot } from '@shared/contract/agentTree';
import type { TaskProgressData } from '@shared/contract';
import type { RunUiStatus } from '../types/runWorkbench';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore } from '../stores/taskStore';
import { isLiveRunStatus } from '../utils/overviewRunHeader';
import { useAgentTreeSnapshot } from './useAgentTreeSnapshot';
import { useRunWorkbenchModel } from './useRunWorkbenchModel';

export interface TaskActivitySignals {
  agentNodeCount: number;
  taskCount: number;
  taskProgress: TaskProgressData | null;
  runStatus: RunUiStatus;
  /**
   * run 状态的存在证据：本轮 turn 已落投影，或会话侧已进入 running/queued。
   * 空会话里 runStatus 是 statusFromInput 的合成 planning（无完成证据时不再
   * 报 completed），它不携带「有活在跑」的证据——只认状态会把空会话的
   * 「运行中的任务会实时显示在这里」叙事挤掉。
   */
  hasRunPresence: boolean;
}

export function deriveHasTaskActivity(signals: TaskActivitySignals): boolean {
  return signals.agentNodeCount > 0
    || signals.taskCount > 0
    || Boolean(signals.taskProgress)
    || (isLiveRunStatus(signals.runStatus) && signals.hasRunPresence);
}

export interface TaskActivity {
  hasTaskActivity: boolean;
  agentTreeSnapshot: AgentTreeSnapshot | null;
}

export function useTaskActivity(): TaskActivity {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessionTaskProgress = useAppStore((state) => state.sessionTaskProgress);
  const sessionStates = useTaskStore((state) => state.sessionStates);
  const runWorkbench = useRunWorkbenchModel();
  const { snapshot: agentTreeSnapshot } = useAgentTreeSnapshot(currentSessionId);
  const taskProgress = currentSessionId
    ? sessionTaskProgress[currentSessionId] ?? null
    : null;
  const sessionStatus = currentSessionId
    ? sessionStates[currentSessionId]?.status ?? null
    : null;
  // 发送已受理但 turn 还没落投影（Send → 首个流事件）时 turnId 为 null，
  // 此时会话侧已是 running/queued——这段在途窗口仍算活动，空会话（idle）不算。
  const hasRunPresence = runWorkbench.run.identity.turnId !== null
    || sessionStatus === 'running'
    || sessionStatus === 'queued';

  return useMemo(() => ({
    hasTaskActivity: deriveHasTaskActivity({
      agentNodeCount: agentTreeSnapshot?.nodes.length ?? 0,
      taskCount: runWorkbench.tasks.length,
      taskProgress,
      runStatus: runWorkbench.run.status,
      hasRunPresence,
    }),
    agentTreeSnapshot,
  }), [agentTreeSnapshot, runWorkbench.run.status, runWorkbench.run.identity.turnId, runWorkbench.tasks.length, taskProgress, hasRunPresence]);
}
