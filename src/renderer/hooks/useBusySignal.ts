import { useEffect, useMemo, useState } from 'react';
import type { TraceTurn } from '@shared/contract/trace';
import { RENDERER_POLLING } from '@shared/constants';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { isTaskTerminalStatus } from '../utils/agentActivity';
import { findHandedOffCallId, resolveBusySignal } from '../utils/turnBusySignal';

/**
 * resolveBusySignal + 后台任务账本（同会话任务的创建时间与是否存活）。
 * 已交接调用出现而任务还没进账本时：立刻拉一次账本，并给一个有限宽限期，避免账本延迟期间闪出「正在整理回复」。
 */
export function useBusySignal(turn: TraceTurn, sessionId: string | undefined) {
  const allTasks = useBackgroundTaskStore((state) => state.tasks);
  const tasks = useMemo(
    () => (sessionId
      ? allTasks
        .filter((task) => task.sessionId === sessionId)
        .map((task) => ({ createdAt: task.createdAt, live: !isTaskTerminalStatus(task.status) }))
      : []),
    [allTasks, sessionId],
  );
  const handedOffId = findHandedOffCallId(turn);
  const arrived = tasks.some((task) => task.createdAt >= turn.startTime);
  const waiting = turn.status === 'streaming' && handedOffId !== undefined && !arrived;
  const [expiredFor, setExpiredFor] = useState<string | undefined>();

  useEffect(() => {
    if (!waiting) return undefined;
    void useBackgroundTaskStore.getState().refreshTasks();
    const timer = setTimeout(() => setExpiredFor(handedOffId), RENDERER_POLLING.HANDOFF_LEDGER_GRACE);
    return () => clearTimeout(timer);
  }, [waiting, handedOffId]);

  return resolveBusySignal(turn, { tasks, awaitingLedger: waiting && expiredFor !== handedOffId });
}
