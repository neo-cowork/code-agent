// 用户 Stop 的会话级后台收线：同步触发该会话所有运行中后台工作的 abort（不 await、逐个 try/catch），
// 再限时等待它们收线。前台取消由调用方并行推进，本函数不碰前台。
import { createLogger } from '../services/infra/logger';
import { CANCELLATION_TIMEOUTS } from '../../shared/constants';
import { getBackgroundSubagentRegistry } from '../agent/backgroundSubagentRegistry';
import type { BackgroundTaskRun } from './taskManagerTypes';

const logger = createLogger('SessionBackgroundStop');

interface SessionBackgroundStopInput {
  sessionId: string;
  backgroundRuns: ReadonlyMap<string, BackgroundTaskRun>;
  cancelBackgroundTask: (taskId: string) => Promise<boolean>;
  settleWaitMs?: number;
}

/** 调用返回时所有 abort 已经发出；返回的 promise 在全部收线或超时后 resolve（永不 reject）。 */
export function stopSessionBackgroundWork(input: SessionBackgroundStopInput): Promise<void> {
  const pending = new Map<string, Promise<unknown>>();

  for (const run of input.backgroundRuns.values()) {
    if (run.sessionId !== input.sessionId || run.status !== 'running') continue;
    try {
      pending.set(run.taskId, input.cancelBackgroundTask(run.taskId));
    } catch (error) {
      logger.warn('Background task cancel threw on session stop', {
        sessionId: input.sessionId,
        taskId: run.taskId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    for (const { agentId, settled } of getBackgroundSubagentRegistry().cancelSession(input.sessionId)) {
      pending.set(agentId, settled);
    }
  } catch (error) {
    logger.warn('Background subagent cancel failed on session stop', {
      sessionId: input.sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (pending.size === 0) return Promise.resolve();

  const waitMs = input.settleWaitMs ?? CANCELLATION_TIMEOUTS.SESSION_BACKGROUND_SETTLE_WAIT;
  const unsettled = new Set(pending.keys());
  const tracked = [...pending].map(([id, promise]) => (
    Promise.resolve(promise).then(() => undefined, () => undefined).then(() => { unsettled.delete(id); })
  ));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); });
  return Promise.race([Promise.allSettled(tracked).then(() => undefined), timeout]).then(() => {
    if (unsettled.size > 0) {
      logger.warn('Background work did not settle after session stop', {
        sessionId: input.sessionId,
        waitMs,
        taskIds: [...unsettled],
      });
    }
  }).finally(() => clearTimeout(timer));
}
