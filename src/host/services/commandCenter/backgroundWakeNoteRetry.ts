// 后台任务唤醒失败句的「登录恢复窗口」补写。
//
// 失败句本身走 addMessageToSession（按 owner 过滤），会话不可读时同样写不进——
// 唤醒轮失败 + 失败句写不进叠在一起，用户就什么都看不到。这里先立刻写一次，
// 写不进就等原 owner 的登录态信号补写一次（无轮询）。文案复用 foregroundWake
// 的句式，不自造新文案。刻意只依赖 foregroundWake / authService / logger：
// idle-wake 等轻消费方动态引它不会再拖进 sessionManager 那条重链。
import { formatBackgroundWakeFailureNote, recordBackgroundWakeFailureNote } from './foregroundWake';
import { isSessionNotAccessibleError } from './sessionAccessRetry';
import { getAuthService } from '../auth/authService';
import { createLogger } from '../infra/logger';

const logger = createLogger('BackgroundWakeNoteRetry');

export async function recordBackgroundWakeFailureNoteWithOwnerRetry(input: {
  sessionId: string;
  taskId: string;
  shortName: string;
  reason: 'owner_missing' | 'wake_failed';
}): Promise<void> {
  const content = formatBackgroundWakeFailureNote(input.shortName);
  const write = (): Promise<void> => recordBackgroundWakeFailureNote(
    input.sessionId,
    content,
    { taskId: input.taskId, reason: input.reason },
  );
  const warnNotRecorded = (error: unknown): void => {
    logger.warn('Background wake failure note not recorded', {
      reason: 'wake_failure_note_not_recorded',
      sessionId: input.sessionId,
      taskId: input.taskId,
      message: error instanceof Error ? error.message : String(error),
    });
  };
  try {
    await write();
    return;
  } catch (error) {
    warnNotRecorded(error);
  }
  try {
    let inFlight = false;
    const unsubscribe = getAuthService().addAuthChangeCallback((user) => {
      if (!user || inFlight) return;
      inFlight = true;
      void write().then(unsubscribe).catch((error: unknown) => {
        warnNotRecorded(error);
        // An unrelated account must not consume the original owner's note.
        if (!isSessionNotAccessibleError(error)) unsubscribe();
      }).finally(() => { inFlight = false; });
    });
  } catch (error) {
    warnNotRecorded(error);
  }
}
