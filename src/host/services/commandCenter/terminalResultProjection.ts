// settle() 终态投影 + 它在登录恢复窗口内的有界重试。
//
// 背景（N-FIX-BG-WAKE-SKIPPED-SESSION-INACCESSIBLE-AFTER-LOGIN-RESTORE-REDRAFT-FU1）：
// projectTerminalResult 走 addMessageToSession → assertAccessibleSession，owner 还没恢复时
// 直接抛「Session X not found」。旧 settle 把投影和唤醒包在同一个 try 里，投影一抛，
// 唤醒也被跳过——[任务结果] 行、唤醒汇报、失败句一样都落不下，只剩一行 warn。
// 这里把默认投影实现（确定性消息 id + 人话状态词）和它的离线重试收在一起；
// settle 只等首次尝试，重试全部离开关键路径（不能推迟 startable 的下一轮 launch）。
import type { SessionCommandTask } from './sessionCommandCenter';
import { buildSessionTaskResultMessage } from './sessionCommandTaskRestartRecovery';
import type { SessionTaskResultStatusWordLocale } from '../../../shared/constants/sessionCommandCenter';
import { createSessionAccessRetry } from './sessionAccessRetry';
import { recordBackgroundWakeFailureNoteWithOwnerRetry } from './backgroundWakeNoteRetry';
import { getSessionManager } from '../infra/sessionManager';
import { getConfigService } from '../core/configService';
import { createLogger } from '../infra/logger';

const logger = createLogger('TerminalResultProjection');

export type TerminalResultStatus = 'completed' | 'failed' | 'cancelled';

function resolveLocale(): SessionTaskResultStatusWordLocale {
  try {
    return getConfigService().getSettings().ui.language;
  } catch {
    return 'zh';
  }
}

/**
 * 正常终态的 [任务结果] 行。消息 id 由 taskId 派生：迟到的重试与正常写撞同一 id 时
 * addMessageToSession 走幂等分支（更新而非插入），不会写出第二行。
 */
export async function projectTerminalResult(
  task: SessionCommandTask,
  status: TerminalResultStatus,
): Promise<void> {
  // 模型读的是 resultText（1500 封顶带截断标记），不是 240 字 summary；
  // backgroundTaskResult.metadata 的 reader 只取 taskId/artifacts，不拿它当 UI 文案。
  const resultText = task.resultText ?? task.summary;
  await getSessionManager().addMessageToSession(
    task.sessionId,
    buildSessionTaskResultMessage(task, status, resultText, `session-task-result-${task.id}`, resolveLocale()),
  );
}

/**
 * 投影因「会话对当前 owner 不可读」失败后的离线重试：与 foregroundWake 同一组界
 * （BACKGROUND_WAKE_OWNER_*）与登录态信号；耗尽后写一句人话（见 backgroundWakeNoteRetry），
 * 写不进就留有区别度的 warn。settle 不等这个重试。
 */
export function deferTerminalResultProjectionUntilAccessible(input: {
  task: SessionCommandTask;
  status: TerminalResultStatus;
  /** settle 侧的写入口；缺省走本模块的产线实现，SessionCommandCenter 传入尊重 DI 的那个。 */
  write?: (task: SessionCommandTask, status: TerminalResultStatus) => Promise<void>;
  /** 重试落定后的收尾（如清 running 标记）。 */
  onSettled?: () => void;
  logger?: { warn(message: string, details?: unknown): void };
}): void {
  const { task, status } = input;
  const write = input.write ?? projectTerminalResult;
  createSessionAccessRetry({
    reasonKey: 'terminal_projection',
    attemptsUsed: 1,
    logContext: { sessionId: task.sessionId, taskId: task.id },
    attempt: () => write(task, status),
    onExhausted: () => recordBackgroundWakeFailureNoteWithOwnerRetry({
      sessionId: task.sessionId,
      taskId: task.id,
      shortName: task.shortName,
      reason: 'wake_failed',
    }),
    onSettled: input.onSettled,
    logger: input.logger ?? logger,
  }).start();
}
