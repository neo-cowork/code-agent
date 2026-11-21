import { useMemo } from 'react';
import type { TraceTurn } from '@shared/contract/trace';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { isTaskTerminalStatus } from '../utils/agentActivity';
import { resolveBusySignal } from '../utils/turnBusySignal';

/** resolveBusySignal + 后台任务账本：同会话里仍未结束的后台任务的创建时间。 */
export function useBusySignal(turn: TraceTurn, sessionId: string | undefined) {
  const tasks = useBackgroundTaskStore((state) => state.tasks);
  const liveStarts = useMemo(
    () => (sessionId
      ? tasks
        .filter((task) => task.sessionId === sessionId && !isTaskTerminalStatus(task.status))
        .map((task) => task.createdAt)
      : []),
    [tasks, sessionId],
  );
  return resolveBusySignal(turn, liveStarts);
}
