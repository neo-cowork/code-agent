import { readUiLanguage } from './sessionTitleHostPrompt';
// ============================================================================
// Background Task Manager - 后台任务管理
// ============================================================================

import { EventEmitter } from 'events';
import { AppWindow, broadcastToRenderer } from '../platform';
import { createLogger } from '../services/infra/logger';
import { getSessionManager, notificationService } from '../services';
import { isRoleWakeRunActive } from '../services/roleAssets/wakeRunGuard';
import { BACKGROUND_NOTIFICATION_TIMEOUTS, BACKGROUND_TASK_CANCELLED, BACKGROUND_TASK_DELETE_INCOMPLETE, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../shared/constants';
import type { BackgroundSessionInfo, BackgroundTaskUpdateEvent } from '../../shared/contract/sessionState';
import { buildSessionTitle, isPlaceholderSessionTitle } from '../../shared/sessionTitlePlaceholder';
import { hasPendingSessionTitle, waitForPendingSessionTitle } from './pendingSessionTitle';

const logger = createLogger('BackgroundTaskManager');
const UNNAMED_SESSION_TITLE = '未命名会话';

/**
 * 后台任务管理器
 *
 * 管理会话的前后台切换：
 * - moveToBackground(): 将运行中的会话移至后台
 * - moveToForeground(): 将后台会话恢复到前台
 * - 后台任务完成时发送系统通知
 */
class BackgroundTaskManager extends EventEmitter {
  private backgroundSessions: Map<string, BackgroundSessionInfo> = new Map();
  private mainWindow: AppWindow | null = null;

  /**
   * 设置主窗口引用（用于发送事件）
   */
  setMainWindow(window: AppWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * 将会话移至后台
   */
  async moveToBackground(sessionId: string): Promise<boolean> {
    // 检查会话是否存在且正在运行
    const sessionManager = getSessionManager();
    const session = await sessionManager.getSession(sessionId);

    if (!session) {
      logger.warn('Session not found', { sessionId });
      return false;
    }

    // 检查是否已在后台：running 条目重复请求是 no-op；终态条目（完成/失败/停止行
    // 常驻面板直到用户清除）要重置回 running——否则同一会话再次转后台后，新 run 的
    // 终态收线会撞上旧终态条目被 running-guard 挡掉，面板永远显示旧结果。
    const existing = this.backgroundSessions.get(sessionId);
    if (existing) {
      if (existing.status === 'running') {
        logger.debug('Session already in background', { sessionId });
        return true;
      }
      this.backgroundSessions.delete(sessionId);
      this.emitUpdate({ type: 'removed', task: existing });
    }

    const sessionInfo: BackgroundSessionInfo = {
      sessionId,
      title: session.title || UNNAMED_SESSION_TITLE,
      startedAt: Date.now(),
      backgroundedAt: Date.now(),
      status: 'running',
    };

    this.backgroundSessions.set(sessionId, sessionInfo);

    logger.info('Session moved to background', { sessionId, title: sessionInfo.title });

    this.emitUpdate({
      type: 'added',
      task: sessionInfo,
    });

    return true;
  }

  /**
   * 将后台会话恢复到前台
   */
  moveToForeground(sessionId: string): BackgroundSessionInfo | null {
    const task = this.backgroundSessions.get(sessionId);

    if (!task) {
      logger.debug('Session not in background', { sessionId });
      return null;
    }

    this.backgroundSessions.delete(sessionId);

    logger.info('Session moved to foreground', { sessionId });

    this.emitUpdate({
      type: 'removed',
      task,
    });

    return task;
  }

  /**
   * 更新后台任务进度
   */
  updateProgress(sessionId: string, progress: number): void {
    const task = this.backgroundSessions.get(sessionId);
    if (!task) return;

    task.progress = Math.min(100, Math.max(0, progress));

    this.emitUpdate({
      type: 'updated',
      task,
    });
  }

  /**
   * 标记后台任务完成
   *
   * running-guard：只收 running 态的条目。同一条目的 task_complete 与 agent_complete
   * 收口点会先后到、SSE 重放也可能重复投递——已收线的条目再收一次只会重复弹通知，
   * 不允许。终态条目常驻列表直到用户清除（dismissTerminal）或切前台——不自动删除，
   * 否则用户没盯着面板的 3 秒窗口一过结果就没了（N-BGPANEL-STOP-TERMINAL）。
   */
  async markCompleted(sessionId: string, message?: string, duration?: number): Promise<void> {
    const task = this.backgroundSessions.get(sessionId);
    if (task?.status !== 'running') return;

    task.status = 'completed';
    task.progress = 100;
    task.completionMessage = message;

    logger.info('Background task completed', { sessionId, message });

    this.emitUpdate({
      type: 'completed',
      task,
    });

    // Keep background settlement, while a running role wake owns its output notification.
    if (isRoleWakeRunActive(sessionId)) return;

    // Only the OS banner waits for an in-flight auto-title job; detach so terminal
    // settlement callers (agent_complete, companion push, semaphore release) never block.
    if (hasPendingSessionTitle(sessionId)) {
      void this.finishMarkCompletedNotification(sessionId, task, message, duration).catch((err: unknown) => {
        logger.warn('Deferred completion notification failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }

    await this.finishMarkCompletedNotification(sessionId, task, message, duration);
  }

  private async finishMarkCompletedNotification(
    sessionId: string,
    task: BackgroundSessionInfo,
    message?: string,
    duration?: number,
  ): Promise<void> {
    // 终态与 running-guard 已同步落定；标题读取慢/卡住不拖面板收线。读完后条目被切前台/
    // 重新入后台（map 里已不是这个对象）就不再通知，免得盖掉新条目。
    if (!(await this.refreshLiveTitle(sessionId, task))) return;

    // 发送系统通知。force：后台完成提醒绕过焦点门——用户可能正停在 app 里聊别的会话
    // （与 loop/定时任务同一档「默默长跑、完成才冒头」）。通知摘要不吃裸 code
    // （USER_CANCELLED 由 renderer 翻译面板行；系统通知这头就地给人话）。
    logger.info('notifyTaskComplete', { sessionId });
    notificationService.notifyTaskComplete({
      sessionId,
      sessionTitle: task.title,
      summary: message === BACKGROUND_TASK_CANCELLED
        ? (readUiLanguage() === 'en' ? 'Task stopped' : '任务已停止')
        : message || (readUiLanguage() === 'en' ? 'Task completed' : '任务已完成'),
      duration,
      toolsUsed: [],
    }, { force: true });
  }

  /**
   * 标记后台任务失败
   *
   * running-guard 同 markCompleted。通知 force：用户多半停在 app 里聊别的会话，
   * 失败与完成同一档「默默长跑、终态才冒头」——焦点门不该吞掉失败提醒
   * （2026-10-11 验收：撞 max-step 上限的失败轮无任何提示）。
   */
  async markFailed(sessionId: string, error?: string, duration?: number, leftoverPaths?: string[]): Promise<void> {
    const task = this.backgroundSessions.get(sessionId);
    if (task?.status !== 'running') return;

    task.status = 'failed';
    if (leftoverPaths) task.leftoverPaths = leftoverPaths;
    task.completionMessage = error || (readUiLanguage() === 'en' ? 'Task failed' : '任务执行失败');

    logger.warn('Background task failed', { sessionId, error });

    this.emitUpdate({
      type: 'failed',
      task,
    });

    // Only the OS banner waits for an in-flight auto-title job; detach so terminal
    // settlement callers (agent_complete, companion push, semaphore release) never block.
    if (hasPendingSessionTitle(sessionId)) {
      void this.finishMarkFailedNotification(sessionId, task, error, duration).catch((err: unknown) => {
        logger.warn('Deferred failure notification failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }

    await this.finishMarkFailedNotification(sessionId, task, error, duration);
  }

  private async finishMarkFailedNotification(
    sessionId: string,
    task: BackgroundSessionInfo,
    error?: string,
    duration?: number,
  ): Promise<void> {
    if (!(await this.refreshLiveTitle(sessionId, task))) return;

    // 发送系统通知。succeeded:false → 标题「任务失败」；MAX_ITERATIONS code 就地翻人话。
    notificationService.notifyTaskComplete({
      sessionId,
      sessionTitle: task.title,
      ...(error === BACKGROUND_TASK_DELETE_INCOMPLETE ? { code: error } : {}),
      summary: error === RUN_ERROR_CODE_MAX_ITERATIONS
        ? '已达最大执行轮次，任务停止（部分结果已保留）'
        : `任务失败: ${error || '未知错误'}`,
      duration,
      toolsUsed: [],
      succeeded: false,
    }, { force: true });
  }

  /**
   * 终态标题优先读持久化标题；早期会话可能只有首条消息或移入后台时的草稿。
   * 返回 false = 读取期间条目已被移出/替换，调用方不应再通知。
   */
  private async refreshLiveTitle(sessionId: string, task: BackgroundSessionInfo): Promise<boolean> {
    try {
      if (hasPendingSessionTitle(sessionId)) {
        const waitResult = await waitForPendingSessionTitle(sessionId, BACKGROUND_NOTIFICATION_TIMEOUTS.TITLE_WAIT_MS);
        if (this.backgroundSessions.get(sessionId) !== task) return false;
        if (waitResult.status === 'timeout') {
          logger.warn('Pending session title wait timed out before notification', {
            reason: 'title_wait_timeout',
            sessionId,
            waitedMs: waitResult.waitedMs,
            timeoutMs: BACKGROUND_NOTIFICATION_TIMEOUTS.TITLE_WAIT_MS,
          });
        } else if (waitResult.status === 'settled') {
          logger.info('Waited for pending session title before notification', {
            sessionId,
            waitedMs: waitResult.waitedMs,
          });
        }
      }
      const sessionManager = getSessionManager();
      const session = await sessionManager.getSession(sessionId);
      if (this.backgroundSessions.get(sessionId) !== task) return false;
      // Web 标题写入可能早于宿主会话缓存刷新，直接读取已持久化的标题。
      const live = (sessionManager.getSessionTitle(sessionId) ?? session?.title)?.trim();
      if (live && !isPlaceholderSessionTitle(live)) {
        task.title = live;
      } else if (task.title === UNNAMED_SESSION_TITLE || isPlaceholderSessionTitle(task.title)) {
        const messages = await sessionManager.getMessages(sessionId);
        if (this.backgroundSessions.get(sessionId) !== task) return false;
        const firstUser = messages.find(message => message.role === 'user' && !message.isMeta);
        const draft = firstUser && buildSessionTitle(firstUser.content, firstUser.attachments?.[0]?.name);
        task.title = draft?.trim() ? draft : session?.title?.trim() || task.title;
      }
      return true;
    } catch {
      return this.backgroundSessions.get(sessionId) === task;
    }
  }

  /**
   * 清除已结束的后台条目（终态行手动清除，N-BGPANEL-STOP-TERMINAL）
   *
   * running 态 no-op：运行中的条目只能停（AGENT_CANCEL 走 run 取消链路）或切前台，
   * 不允许从面板凭空消失。
   */
  dismissTerminal(sessionId: string): boolean {
    const task = this.backgroundSessions.get(sessionId);
    if (!task || task.status === 'running') {
      logger.debug('Background task not dismissible', { sessionId });
      return false;
    }

    this.backgroundSessions.delete(sessionId);

    logger.info('Background task dismissed', { sessionId });

    this.emitUpdate({
      type: 'removed',
      task,
    });

    return true;
  }

  /**
   * 检查会话是否在后台运行
   */
  isInBackground(sessionId: string): boolean {
    return this.backgroundSessions.has(sessionId);
  }

  /**
   * 后台条目是否仍是 running 态（收线幂等判据：completed/failed 都算已收线）
   */
  isTaskRunning(sessionId: string): boolean {
    return this.backgroundSessions.get(sessionId)?.status === 'running';
  }

  /**
   * 获取所有后台任务
   */
  getAllTasks(): BackgroundSessionInfo[] {
    return Array.from(this.backgroundSessions.values());
  }

  /**
   * 获取后台任务数量
   */
  getTaskCount(): number {
    return this.backgroundSessions.size;
  }

  /**
   * 发送更新事件到渲染进程
   */
  private emitUpdate(event: BackgroundTaskUpdateEvent): void {
    this.emit('update', event);

    // web 路径（浏览器/无槽验证）：与 notificationService.deliver 同款 renderer bus → SSE。
    // Tauri 渲染端不走 SSE（bridge 模式无订阅者，emit 静默丢弃），不会与 webContents 重复投递。
    broadcastToRenderer('background:task:update', event);

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('background:task:update', event);
    }
  }
}

// Global singleton
let globalInstance: BackgroundTaskManager | null = null;

/**
 * 获取全局 BackgroundTaskManager 实例
 */
export function getBackgroundTaskManager(): BackgroundTaskManager {
  if (!globalInstance) {
    globalInstance = new BackgroundTaskManager();
  }
  return globalInstance;
}

/**
 * 重置全局实例（用于测试）
 */
export function resetBackgroundTaskManager(): void {
  globalInstance = null;
}

export { BackgroundTaskManager };
