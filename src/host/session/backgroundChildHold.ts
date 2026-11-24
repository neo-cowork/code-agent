// 后台父会话的收口必须等委派子任务（delegate_task / 指挥台任务）真正终态。
// 排队中的子任务也算在途：它还没跑，不能先把父行标完成。
// 查指挥台用动态 import：本模块被 backgroundTaskTerminal 引用，而 TaskManager
// 又引用后者，静态 import 会在模块初始化时绕回 SessionCommandCenter。

import { createLogger } from '../services/infra/logger';
import { getBackgroundTaskManager } from './backgroundTaskManager';
import {
  resolveBackgroundRunSettlement,
  settleBackgroundRun,
  type BackgroundRunSettlementInput,
} from './backgroundRunSettlement';

const logger = createLogger('BackgroundChildHold');
const loadCommandCenter = () => import('../services/commandCenter/sessionCommandCenter');

export async function inFlightDelegatedChildCount(sessionId: string, taskId?: string): Promise<number> {
  const { getSessionCommandCenter } = await loadCommandCenter();
  const tasks = getSessionCommandCenter().active(sessionId);
  return taskId === undefined || tasks.some(task => task.id === taskId) ? tasks.length : 0;
}

/** 仍有在途委派子任务时跳过本次收口。调用方不得再 markCompleted / notify。 */
export async function deferBackgroundSettlementWhileChildrenInFlight(
  sessionId: string,
  input?: BackgroundRunSettlementInput,
): Promise<boolean> {
  const { getSessionCommandCenter } = await loadCommandCenter();
  const inFlightChildren = getSessionCommandCenter().active(sessionId).length;
  if (inFlightChildren === 0) return false;
  if (input?.status === 'error') getBackgroundTaskManager().rememberDeferredRunFailure(sessionId, input);
  logger.info('Deferring background run settlement until delegated children finish', {
    sessionId,
    inFlightChildren,
  });
  return true;
}

/**
 * Web 直连轮（agent.ts 成功路径与 catch）的后台收口。
 * 不在后台、或条目已不是 running：成功路径保持 no-op；失败路径仍 markFailed
 * （无 running 条目时管理器自己 no-op），与改前一致。
 */
export async function settleWebTurnBackgroundRun(
  sessionId: string,
  input: BackgroundRunSettlementInput,
): Promise<void> {
  const manager = getBackgroundTaskManager();
  if (manager.isInBackground(sessionId) && manager.isTaskRunning(sessionId)) {
    if (await deferBackgroundSettlementWhileChildrenInFlight(sessionId, input)) return;
    const settlement = input.status === 'completed' ? manager.getDeferredRunFailure(sessionId) ?? input : input;
    await settleBackgroundRun(manager, sessionId, resolveBackgroundRunSettlement(settlement));
    return;
  }
  if (input.status === 'error') {
    await manager.markFailed(sessionId, resolveBackgroundRunSettlement(input).message);
  }
}
