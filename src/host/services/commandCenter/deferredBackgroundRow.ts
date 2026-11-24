// 委派子任务收尾后，若唤醒轮到不了父会话的后台收口，就在这里把后台行补上。
// 不引用 sessionCommandCenter：那边的加载链会绕回本模块的调用方。

import { createLogger } from '../infra/logger';
import { getBackgroundTaskManager } from '../../session/backgroundTaskManager';
import { unionLeftoverPaths } from '../../session/backgroundChildHold';
import { resolveBackgroundRunSettlement, settleBackgroundRun } from '../../session/backgroundRunSettlement';

const logger = createLogger('DeferredBackgroundRow');

export function rememberDelegatedSessionStop(sessionId: string): void {
  const manager = getBackgroundTaskManager();
  if (manager.isTaskRunning(sessionId) || manager.getDeferredRun(sessionId)) {
    manager.rememberDeferredRun(sessionId, { status: 'interrupted' });
  }
}

type TerminalTaskStatus = 'completed' | 'failed' | 'cancelled';

interface SettledChild {
  id: string;
  sessionId: string;
  stopped?: { kind?: string };
  leftoverPaths?: string[];
}

export async function releaseDelegatedChildSettlement(input: {
  task: SettledChild;
  status: TerminalTaskStatus;
  terminalResultDelivered: boolean;
  inFlightChildren: () => number;
  primaryRunActive: () => boolean;
  onPrimaryIdle?: (listener: () => void) => () => void;
  wake: () => Promise<void>;
}): Promise<void> {
  const background = getBackgroundTaskManager();
  const stoppedKind = input.task.stopped?.kind;
  if (input.task.leftoverPaths) {
    logger.info('foreground_wake_skipped_delete_incomplete', { taskId: input.task.id });
  } else if (input.terminalResultDelivered && (stoppedKind === 'step_cap' || stoppedKind === 'no_conclusion')) {
    logger.info('foreground_wake_skipped_stop_note_delivered', { taskId: input.task.id, kind: stoppedKind });
  } else {
    const wake = () => {
      void Promise.resolve().then(input.wake).catch((error: unknown) => {
        logger.warn('Failed to wake text foreground brain after task settlement', {
          taskId: input.task.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    };
    if (!background.deferWakeUntilParentSettles(input.task.sessionId, wake)) wake();
  }

  if (input.inFlightChildren() > 0) return;
  // Only a parent terminal closer or an explicit Stop can hand this row to the child.
  // Registry idle alone can precede the parent's error or cancellation persistence.
  const deferred = background.getDeferredRun(input.task.sessionId);
  if (!deferred) return;

  const settle = async (): Promise<void> => {
    if (input.inFlightChildren() > 0 || input.primaryRunActive()) return;
    const live = getBackgroundTaskManager();
    // 按会话重读当前记录：前台新一轮可能已换掉它，按引用比较会让补收永远不触发。
    const current = live.getDeferredRun(input.task.sessionId);
    if (!current) return;
    if (!live.isTaskRunning(input.task.sessionId)) {
      // 前台新一轮取代的结果留给之后转后台的新行；没被取代的旧结果作废。
      if (!current.superseded) live.clearDeferredRun(input.task.sessionId);
      return;
    }
    const leftoverPaths = unionLeftoverPaths(current.input.leftoverPaths, live.getDelegatedLeftovers(input.task.sessionId));
    const parentOutcome = current.input.status === 'completed' ? undefined : current.input;
    logger.info('Settling deferred background run from delegated child', {
      sessionId: input.task.sessionId,
      taskId: input.task.id,
      status: input.status,
      ...(parentOutcome ? { parentStatus: parentOutcome.status } : {}),
    });
    try {
      await settleBackgroundRun(live, input.task.sessionId, resolveBackgroundRunSettlement(parentOutcome ?? (
        leftoverPaths?.length
          ? { status: 'completed', leftoverPaths }
          : { status: input.status === 'cancelled' ? 'interrupted' : input.status === 'failed' ? 'error' : 'completed' }
      )));
    } catch (error) {
      logger.warn('Failed to settle deferred background run from delegated child', {
        sessionId: input.task.sessionId,
        taskId: input.task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // 父轮的收口已经因为子任务在途而返回，但主 run 还没释放：等它释放后再补收，
  // 否则这段窗口里没有第二次收口调用，后台行会停在 running。
  if (input.primaryRunActive()) {
    if (!input.onPrimaryIdle) return;
    const stop = input.onPrimaryIdle(() => {
      if (input.primaryRunActive()) return;
      stop();
      void settle();
    });
    return;
  }
  await settle();
}
