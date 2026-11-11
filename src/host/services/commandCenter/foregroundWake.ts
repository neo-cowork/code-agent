import type { AgentEvent, Message, TaskProgressData } from '../../../shared/contract';
import type { SystemEventMessageMetadata } from '../../../shared/contract/systemEventRegistry';
import {
  BACKGROUND_WAKE_DEFER_NOTICE_MS,
  BACKGROUND_WAKE_DEFER_PROGRESS,
  BACKGROUND_WAKE_DEFER_TASK_TITLE_MAX_CHARS,
  BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS,
  BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS,
  formatBackgroundWakeDeferredNote,
  MAX_CONSECUTIVE_WAKES,
  SESSION_COMMAND_CENTER_WAKE_MAX_ITERATIONS,
} from '../../../shared/constants/sessionCommandCenter';
import type { AgentOrchestrator } from '../../agent/agentOrchestrator';
import type { AgentRunOptions } from '../../research/types';
import { getPermissionModeManager } from '../../permissions/modes';
import { getTaskManager } from '../../task/TaskManager';
import { truncateObserveText } from '../../tools/observeModeGate';
import { withSessionCommandCenterBrain } from '../../app/sessionCommandCenterBrain';
import { getDatabase } from '../core/databaseService';
import { QueuedInputRepository } from '../core/repositories/QueuedInputRepository';
import { getAuthService } from '../auth/authService';
import { getSessionManager, type SessionWithMessages } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import type { SessionCommandTask } from './sessionCommandCenter';

import { WAKE_NOOP_TOOL_NAME } from '../../../shared/constants/agent';
import { getAgentErrorMessage } from '../../../shared/utils/agentErrorClassification';

const FOREGROUND_WAKE_CONTRACT = [
  '<background_task_hidden_wake>',
  '这一轮由后台任务终态触发，不是用户正在等待你确认的消息。',
  '不要写“收到”“好的”等承接语，不要把后台结果当成用户消息引用。',
  '只有存在对用户有信息量的交付物、结论，或失败后需要用户决定时，才输出文字；直接给结论。',
  '需要继续执行时调用 delegate_task。',
  `没有值得告知用户的内容时，只调用 ${WAKE_NOOP_TOOL_NAME}，不要输出任何文字。`,
  '</background_task_hidden_wake>',
].join('\n');

type WakeStatus = 'completed' | 'failed' | 'cancelled';

interface WakeTaskManager {
  getSessionState(sessionId: string): { status: string };
  getWaitingQueue(): string[];
  hasActivePrimaryRun(sessionId: string): boolean;
  getOrCreateCurrentOrchestrator(sessionId: string): AgentOrchestrator | undefined;
  setSessionContext(sessionId: string, messages: Message[]): void;
  setWorkingDirectory(sessionId: string, directory: string): void;
  /** TaskManager 的 state_change：会话回到 idle 是延后唤醒的投递信号之一（不另起轮询） */
  on(event: 'state_change', listener: (event: { sessionId: string; data?: unknown }) => void): unknown;
  /** RunRegistry 有 run 退场（前台轮结束）：延后唤醒的另一个投递信号，web 入口的轮不经 state_change */
  onRunIdle(listener: () => void): unknown;
  /** 注入与前台 orchestrator 相同的 agent-event 广播链。 */
  emitAgentEventForSession(sessionId: string, event: AgentEvent): void;
  /** 前台轮的后续 progress 会覆盖推迟说明；旁听后在同一节拍补回。 */
  observeAgentEvents(
    observer: (sessionId: string, event: AgentEvent, taskId?: string) => void,
  ): () => void;
}

interface WakeLogger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
}

export interface ForegroundWakeDependencies {
  getTaskManager(): WakeTaskManager;
  loadSession(sessionId: string): Promise<SessionWithMessages | null>;
  hasQueuedUserInput(sessionId: string): boolean;
  isVoiceSession(sessionId: string): boolean;
  /** 唤醒轮失败时给用户的一句人话（任务结果本身已由 projectTerminalResult 落在会话里） */
  recordWakeFailureNote(
    sessionId: string,
    content: string,
    detail: { taskId: string; reason: 'owner_missing' | 'wake_failed' },
  ): Promise<void>;
  /** 唤醒推迟超过上限时给用户的一句不打断说明。 */
  recordWakeDeferredNote(
    sessionId: string,
    content: string,
    detail: { taskId: string; outcome: 'completed' | 'failed' },
  ): Promise<void>;
  /** 可注入的计时器，避免单测真等待。 */
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  /** 登录态恢复期间会话按 owner 过滤读不到：当前是否已有登录用户（仅用于日志区分原因）。 */
  isOwnerSignedIn?(): boolean;
  /** 订阅登录态变化；返回取消订阅函数。 */
  subscribeAuthChange?(callback: (signedIn: boolean) => void): () => void;
  logger: WakeLogger;
}

interface ConsecutiveWakeState {
  lastVisibleUserMessageId: string | null;
  count: number;
}

type DeferredWakeStatus = Extract<WakeStatus, 'completed' | 'failed'>;

interface PendingWake {
  task: SessionCommandTask;
  status: DeferredWakeStatus;
  noticeTimer: unknown | null;
  noticeEmitted: boolean;
  flushing: boolean;
  /** 会话对当前 owner 不可读（登录恢复中）已尝试加载的次数；0 = 不在等 owner */
  ownerLoadAttempts: number;
  ownerRetryTimer: unknown | null;
}

const logger = createLogger('ForegroundWake');

function hasQueuedUserInput(sessionId: string): boolean {
  try {
    const db = getDatabase().getDb();
    if (!db) {
      logger.warn('Foreground wake skipped: queued-input database unavailable', { sessionId });
      return true;
    }
    const repository = new QueuedInputRepository(db);
    return repository.listBySession(sessionId, 'queued').length > 0
      || repository.listBySession(sessionId, 'sending').length > 0;
  } catch (error) {
    logger.warn('Foreground wake skipped: queued-input state unavailable', {
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

export function formatBackgroundWakeFailureNote(shortName: string): string {
  return `后台任务「${shortName}」已结束，结果见上方的任务结果；自动汇报这一步没能完成，需要的话可以直接问我。`;
}

export async function recordBackgroundWakeFailureNote(
  sessionId: string,
  content: string,
  detail: { taskId: string; reason: 'owner_missing' | 'wake_failed' },
): Promise<void> {
  // 必须带登记键：渲染端按 systemEventRegistry 放行，无 metadata 的 system 消息一律被投影层跳过
  const message: Message = {
    id: `session-wake-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'system',
    content,
    timestamp: Date.now(),
    metadata: { backgroundWakeFailed: detail } satisfies SystemEventMessageMetadata,
  };
  await getSessionManager().addMessageToSession(sessionId, message);
  // 在线会话立即可见（该 system 'message' 事件只广播、不会被 TaskManager 二次落库）
  getTaskManager().emitAgentEventForSession(sessionId, { type: 'message', data: message });
}

const defaultDependencies: ForegroundWakeDependencies = {
  getTaskManager,
  loadSession: (sessionId) => getSessionManager().getSession(sessionId, Number.MAX_SAFE_INTEGER),
  hasQueuedUserInput,
  isVoiceSession: (sessionId) => getPermissionModeManager().isLiveVoiceSession(sessionId),
  recordWakeFailureNote: recordBackgroundWakeFailureNote,
  recordWakeDeferredNote: async (sessionId, content, detail) => {
    const message: Message = {
      id: `session-wake-deferred-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      content,
      timestamp: Date.now(),
      metadata: { backgroundWakeDeferred: detail } satisfies SystemEventMessageMetadata,
    };
    await getSessionManager().addMessageToSession(sessionId, message);
    getTaskManager().emitAgentEventForSession(sessionId, { type: 'message', data: message });
  },
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  isOwnerSignedIn: () => getAuthService().getCurrentUser() !== null,
  subscribeAuthChange: (callback) => getAuthService().addAuthChangeCallback((user) => callback(user !== null)),
  logger,
};

function latestVisibleUserMessageId(messages: Message[]): string | null {
  return [...messages]
    .reverse()
    .find((message) => message.role === 'user' && !message.isMeta)
    ?.id ?? null;
}

function wakePrompt(task: SessionCommandTask, status: Extract<WakeStatus, 'completed' | 'failed'>): string {
  const outcome = status === 'completed' ? '完成' : '失败';
  // 用户绕过团长直接给这个任务补过话（N-SUBAGENT-INPUT）：收工汇总要知道，免得漏掉用户改过的要求
  const supplement = task.userInputCount ? `期间用户直接给它补了 ${task.userInputCount} 句。` : '';
  // resultText 优先：240 字 summary 会截断「改走 Bash curl 审批」这类可执行提示（FB-577）
  const resultText = task.resultText ?? task.summary ?? task.detail ?? '无摘要';
  return `后台任务 ${task.shortName} 已${outcome}，结果摘要：${resultText}。${supplement}`;
}

export function createForegroundWake(
  dependencies: ForegroundWakeDependencies = defaultDependencies,
): (task: SessionCommandTask, status: WakeStatus) => Promise<void> {
  const consecutiveBySession = new Map<string, ConsecutiveWakeState>();
  const inFlightSessions = new Set<string>();
  // 每会话只记最新一次被推迟的唤醒；会话回到 idle（或在途唤醒结束）时投递一次
  const pendingBySession = new Map<string, PendingWake>();
  let listenersInstalled = false;

  let unsubscribeAuth: (() => void) | null = null;

  const clearOwnerRetryTimer = (pending: PendingWake): void => {
    if (pending.ownerRetryTimer === null) return;
    dependencies.clearTimeout(pending.ownerRetryTimer);
    pending.ownerRetryTimer = null;
  };

  const clearPendingTimer = (pending: PendingWake): void => {
    clearOwnerRetryTimer(pending);
    if (pending.noticeTimer === null) return;
    dependencies.clearTimeout(pending.noticeTimer);
    pending.noticeTimer = null;
  };

  // 没有任何唤醒还在等 owner 时取消登录态订阅，避免泄漏
  const syncAuthSubscription = (): void => {
    if (!unsubscribeAuth) return;
    for (const candidate of pendingBySession.values()) {
      if (candidate.ownerLoadAttempts > 0) return;
    }
    unsubscribeAuth();
    unsubscribeAuth = null;
  };

  const dropPending = (pending: PendingWake): void => {
    if (pendingBySession.get(pending.task.sessionId) === pending) {
      pendingBySession.delete(pending.task.sessionId);
    }
    pending.flushing = false;
    pending.ownerLoadAttempts = 0;
    clearPendingTimer(pending);
    syncAuthSubscription();
  };

  const emitDeferredProgress = (
    manager: WakeTaskManager,
    pending: PendingWake,
    base?: TaskProgressData,
  ): void => {
    manager.emitAgentEventForSession(pending.task.sessionId, {
      type: 'task_progress',
      data: {
        turnId: `background-wake-deferred-${pending.task.id}`,
        phase: 'thinking',
        ...base,
        step: BACKGROUND_WAKE_DEFER_PROGRESS[pending.status],
      },
    });
  };

  const armDeferredNotice = (pending: PendingWake): void => {
    if (pending.noticeEmitted || pending.noticeTimer !== null) return;
    pending.noticeTimer = dependencies.setTimeout(() => {
      if (pendingBySession.get(pending.task.sessionId) !== pending || pending.noticeEmitted) return;
      pending.noticeTimer = null;
      pending.noticeEmitted = true;
      void dependencies.recordWakeDeferredNote(
        pending.task.sessionId,
        formatBackgroundWakeDeferredNote(
          truncateObserveText(pending.task.title, BACKGROUND_WAKE_DEFER_TASK_TITLE_MAX_CHARS),
          pending.status,
        ),
        { taskId: pending.task.id, outcome: pending.status },
      ).catch((error) => {
        dependencies.logger.warn('Foreground wake deferred note not recorded', {
          sessionId: pending.task.sessionId,
          taskId: pending.task.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, BACKGROUND_WAKE_DEFER_NOTICE_MS);
  };

  const defer = (
    manager: WakeTaskManager,
    task: SessionCommandTask,
    status: DeferredWakeStatus,
    reason: string,
    details?: Record<string, unknown>,
    resumedPending?: PendingWake,
  ): void => {
    const existing = pendingBySession.get(task.sessionId);
    let pending: PendingWake;
    if (existing?.task.id === task.id) {
      if (resumedPending && resumedPending !== existing) clearPendingTimer(resumedPending);
      pending = existing;
      pending.task = task;
      pending.status = status;
      pending.flushing = false;
    } else if (resumedPending && existing && existing !== resumedPending) {
      // flush 等待 loadSession 时可能已来了更新的结果；保留「最新一次」的既有语义。
      clearPendingTimer(resumedPending);
      resumedPending.flushing = false;
      pending = existing;
    } else {
      if (existing) dropPending(existing);
      pending = resumedPending ?? {
        task,
        status,
        noticeTimer: null,
        noticeEmitted: false,
        flushing: false,
        ownerLoadAttempts: 0,
        ownerRetryTimer: null,
      };
      pending.task = task;
      pending.status = status;
      pending.flushing = false;
      pendingBySession.set(task.sessionId, pending);
    }
    armDeferredNotice(pending);
    emitDeferredProgress(manager, pending);
    dependencies.logger.info(`Foreground wake deferred: ${reason}`, {
      sessionId: task.sessionId,
      taskId: task.id,
      ...details,
    });
    if (listenersInstalled) return;
    listenersInstalled = true;
    manager.on('state_change', (event) => {
      if ((event.data as { status?: unknown } | undefined)?.status !== 'idle') return;
      flushPending(event.sessionId);
    });
    manager.onRunIdle(() => {
      for (const sessionId of [...pendingBySession.keys()]) {
        if (manager.hasActivePrimaryRun(sessionId)) continue;
        // 退场通知发生在 orchestrator 清 agentLoop 之前的同一同步段，放到微任务再检查 isProcessing
        queueMicrotask(() => flushPending(sessionId));
      }
    });
    manager.observeAgentEvents((sessionId, event, taskId) => {
      if (taskId || event.type !== 'task_progress') return;
      const pendingWake = pendingBySession.get(sessionId);
      if (!pendingWake) return;
      const progress = event.data as TaskProgressData;
      if (progress.step === BACKGROUND_WAKE_DEFER_PROGRESS[pendingWake.status]) return;
      // 真实前台进度（工具/百分比/生成/失败）优先原样放行；只替换无工具信息的「分析请求中」文案
      const hasForegroundDetail = progress.phase !== 'thinking'
        || progress.tool !== undefined || progress.toolIndex !== undefined
        || progress.toolTotal !== undefined || progress.progress !== undefined
        || progress.target !== undefined;
      if (hasForegroundDetail) return;
      emitDeferredProgress(manager, pendingWake, progress);
    });
  };

  // 会话对当前 owner 读不到（登录恢复中 owner 为空）：留在 pending 里，等登录态变化或定时重试。
  // 重投仍走按 owner 过滤的 loadSession，换了别的账号登录读不到就不会投进去。
  const deferUntilSessionAccessible = async (
    manager: WakeTaskManager,
    task: SessionCommandTask,
    status: DeferredWakeStatus,
    pending: PendingWake | undefined,
  ): Promise<boolean> => {
    const sessionId = task.sessionId;
    const attempts = (pending?.task.id === task.id ? pending.ownerLoadAttempts : 0) + 1;
    const ownerSignedIn = dependencies.isOwnerSignedIn?.() ?? false;
    if (attempts >= BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS) {
      dependencies.logger.warn('Foreground wake dropped: session not accessible for current owner after retries', {
        reason: 'session_not_accessible_retries_exhausted',
        sessionId,
        taskId: task.id,
        ownerSignedIn,
        attempts,
      });
      await dependencies.recordWakeFailureNote(
        sessionId,
        formatBackgroundWakeFailureNote(task.shortName),
        { taskId: task.id, reason: 'wake_failed' },
      ).catch((noteError) => {
        dependencies.logger.warn('Foreground wake failure note not recorded', {
          reason: 'session_not_accessible_retries_exhausted',
          sessionId,
          taskId: task.id,
          message: noteError instanceof Error ? noteError.message : String(noteError),
        });
      });
      return false;
    }
    dependencies.logger.warn('Foreground wake waiting: session not accessible for current owner', {
      reason: 'session_not_accessible_for_current_owner',
      sessionId,
      taskId: task.id,
      ownerSignedIn,
      attempts,
    });
    defer(manager, task, status, 'session not accessible for current owner', { attempts }, pending);
    const stored = pendingBySession.get(sessionId);
    if (stored?.task.id !== task.id) return false;
    stored.ownerLoadAttempts = attempts;
    clearOwnerRetryTimer(stored);
    stored.ownerRetryTimer = dependencies.setTimeout(() => {
      stored.ownerRetryTimer = null;
      if (pendingBySession.get(sessionId) === stored) flushPending(sessionId);
    }, BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS);
    if (!unsubscribeAuth && dependencies.subscribeAuthChange) {
      unsubscribeAuth = dependencies.subscribeAuthChange((signedIn) => {
        if (!signedIn) return;
        for (const [waitingSessionId, waiting] of [...pendingBySession]) {
          if (waiting.ownerLoadAttempts > 0) flushPending(waitingSessionId);
        }
      });
    }
    return true;
  };

  const flushPending = (sessionId: string): void => {
    const pending = pendingBySession.get(sessionId);
    if (!pending || pending.flushing || inFlightSessions.has(sessionId)) return;
    pending.flushing = true;
    void wake(pending.task, pending.status, pending).catch((error) => {
      dependencies.logger.warn('Foreground wake failed', {
        sessionId,
        taskId: pending.task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      if (pendingBySession.get(sessionId) === pending) pending.flushing = false;
    });
  };

  const wake = async (
    task: SessionCommandTask,
    status: WakeStatus,
    pending?: PendingWake,
  ): Promise<void> => {
    const sessionId = task.sessionId;
    if (status === 'cancelled') {
      if (pending) dropPending(pending);
      dependencies.logger.info('Foreground wake skipped: task cancelled', { sessionId, taskId: task.id });
      return;
    }
    const manager = dependencies.getTaskManager();
    if (inFlightSessions.has(sessionId)) {
      // 在途唤醒结束后补投，别丢第二个任务的结果
      defer(manager, task, status, 'wake already in flight', undefined, pending);
      return;
    }

    inFlightSessions.add(sessionId);
    let turnRan = false;
    try {
      const session = await dependencies.loadSession(sessionId);
      if (!session) {
        // 已重新入队则 pending 的所有权交给 defer；耗尽则留给 finally 清掉
        if (await deferUntilSessionAccessible(manager, task, status, pending)) pending = undefined;
        return;
      }
      if ((session.type ?? 'chat') !== 'chat') {
        dependencies.logger.info('Foreground wake skipped: not a text chat session', {
          sessionId,
          taskId: task.id,
          sessionType: session.type,
        });
        return;
      }
      if (pending) {
        pending.ownerLoadAttempts = 0;
        clearOwnerRetryTimer(pending);
        syncAuthSubscription();
      }
      if (dependencies.isVoiceSession(sessionId)) {
        dependencies.logger.info('Foreground wake skipped: voice session', { sessionId, taskId: task.id });
        return;
      }

      const state = manager.getSessionState(sessionId);
      if (
        state.status !== 'idle'
        || manager.hasActivePrimaryRun(sessionId)
        || manager.getWaitingQueue().includes(sessionId)
      ) {
        defer(manager, task, status, 'session busy', { status: state.status }, pending);
        pending = undefined;
        return;
      }
      if (dependencies.hasQueuedUserInput(sessionId)) {
        defer(manager, task, status, 'queued user input', undefined, pending);
        pending = undefined;
        return;
      }

      const visibleUserMessageId = latestVisibleUserMessageId(session.messages);
      const previous = consecutiveBySession.get(sessionId);
      const consecutive = previous?.lastVisibleUserMessageId === visibleUserMessageId
        ? previous.count
        : 0;
      if (consecutive >= MAX_CONSECUTIVE_WAKES) {
        dependencies.logger.warn('Foreground wake skipped: consecutive wake limit reached', {
          sessionId,
          taskId: task.id,
          consecutive,
          limit: MAX_CONSECUTIVE_WAKES,
        });
        return;
      }

      const orchestrator = manager.getOrCreateCurrentOrchestrator(sessionId);
      if (!orchestrator) {
        dependencies.logger.info('Foreground wake skipped: no resident foreground orchestrator', {
          sessionId,
          taskId: task.id,
        });
        return;
      }
      if (orchestrator.isProcessing()) {
        defer(manager, task, status, 'foreground orchestrator processing', undefined, pending);
        pending = undefined;
        return;
      }

      if (pending) {
        dropPending(pending);
        pending = undefined;
      }

      manager.setSessionContext(sessionId, session.messages);
      if (session.workingDirectory) manager.setWorkingDirectory(sessionId, session.workingDirectory);

      const brainOptions = withSessionCommandCenterBrain({
        mode: 'normal',
        inputHistoryVisibility: 'meta',
        runRegistration: 'auxiliary',
        maxIterations: SESSION_COMMAND_CENTER_WAKE_MAX_ITERATIONS,
        turnSystemContext: [FOREGROUND_WAKE_CONTRACT],
      });
      let capturedError: string | null = null;
      const options = {
        ...brainOptions,
        mode: 'normal',
        inputHistoryVisibility: 'meta',
        runRegistration: 'auxiliary',
        maxIterations: SESSION_COMMAND_CENTER_WAKE_MAX_ITERATIONS,
        disableAutoAgent: true,
        allowedToolNames: Array.from(new Set([
          ...(brainOptions.allowedToolNames ?? []),
          WAKE_NOOP_TOOL_NAME,
        ])),
        terminalErrorSink: (data: unknown) => {
          if (capturedError === null) {
            capturedError = getAgentErrorMessage(data) ?? 'wake turn failed';
          }
        },
      } satisfies AgentRunOptions;

      consecutiveBySession.set(sessionId, {
        lastVisibleUserMessageId: visibleUserMessageId,
        count: consecutive + 1,
      });
      dependencies.logger.info('Foreground wake starting', {
        sessionId,
        taskId: task.id,
        status,
        consecutive: consecutive + 1,
      });
      turnRan = true;
      let thrownError: string | null = null;
      try {
        await orchestrator.sendMessage(wakePrompt(task, status), undefined, options);
      } catch (error) {
        thrownError = error instanceof Error ? error.message : String(error);
      }
      const failureMessage = capturedError ?? thrownError;
      if (failureMessage !== null) {
        // 失败原因分开记：owner lease 缺失是 run 注册问题，其余是唤醒轮自身失败
        const ownerMissing = failureMessage.includes('no live owner lease');
        dependencies.logger.warn(
          `Foreground wake failed: ${ownerMissing ? 'owner missing' : 'wake turn failed'}`,
          { sessionId, taskId: task.id, message: failureMessage },
        );
        await dependencies.recordWakeFailureNote(
          sessionId,
          formatBackgroundWakeFailureNote(task.shortName),
          { taskId: task.id, reason: ownerMissing ? 'owner_missing' : 'wake_failed' },
        ).catch((noteError) => {
          dependencies.logger.warn('Foreground wake failure note not recorded', {
            sessionId,
            taskId: task.id,
            message: noteError instanceof Error ? noteError.message : String(noteError),
          });
        });
      }
    } finally {
      if (pending) dropPending(pending);
      inFlightSessions.delete(sessionId);
      // 只有真跑过唤醒轮才补投在途期间攒下的那次；推迟/跳过的路径补投会自旋
      if (turnRan) flushPending(sessionId);
    }
  };
  return wake;
}

