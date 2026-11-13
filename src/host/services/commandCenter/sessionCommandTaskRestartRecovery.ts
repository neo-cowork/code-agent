// 指挥台任务的「重启中断」收口。
//
// 指挥台任务只活在内存里，账本只落终态：宿主在任务运行中退出/崩溃，会话里就只剩一句
// 「结果会自动回流」，永远等不到结果也等不到失败。这里用每任务一个小 JSON 标记文件
// （目录 <dataDir>/session-command-running/）记「正在跑」：launch 写、settle 删，
// 启动时剩下的标记 = 上个进程没来得及收尾的任务，补一条与正常终态同形的失败消息。
// 选文件而不是扩账本 store：账本 store 只认终态行，加「运行中」行要动 schema 与查询面，
// 而这里只需要「进程死了还剩谁」一个事实；每任务一个文件也避开并发读改写。
import fs from 'node:fs';
import path from 'node:path';
import type { Message } from '../../../shared/contract';
import { getUserConfigDir } from '../../config/configPaths';
import { getSessionManager } from '../infra/sessionManager';
import { createLogger } from '../infra/logger';
import { getConfigService } from '../core/configService';
import { getDatabase } from '../core';
import { getBackgroundTaskLedger } from '../../task/backgroundTaskLedger';
import { SqliteBackgroundTaskStore } from '../../task/backgroundTaskStore';
import { formatSessionTaskResultStatusWord } from '../../../shared/constants/sessionCommandCenter';
import type { SessionTaskResultStatusWordLocale } from '../../../shared/constants/sessionCommandCenter';
import { createSessionAccessRetry, isSessionNotAccessibleError } from './sessionAccessRetry';

const logger = createLogger('SessionCommandRestartRecovery');

const SESSION_COMMAND_TASK_INTERRUPTED_REASON = 'session_command_task_interrupted_by_restart';
const MARKER_DIR = 'session-command-running';

interface RunningMarker {
  taskId: string;
  sessionId: string;
  title: string;
  shortName: string;
  createdAt: number;
  startedAt: number;
  /**
   * settle 已落终态、但「[任务结果]」投影还在会话不可读重试中（登录恢复窗口）：
   * 这份终态快照让重启恢复按真实结局补投，而不是把已完成任务当中断改写成 failed
   * （Rework r1：不带它，重试窗口内崩溃 → 下次启动账本 completed 被覆盖成
   * failed(interrupted)、会话里出现假的中断行）。
   */
  terminal?: {
    status: ResultStatus;
    resultText?: string;
    summary?: string;
    detail?: string;
    settledAt: number;
  };
}

type ResultStatus = 'completed' | 'failed' | 'cancelled';

function markerDir(): string {
  return path.join(getUserConfigDir(), MARKER_DIR);
}

function markerPath(taskId: string): string {
  return path.join(markerDir(), `${encodeURIComponent(taskId)}.json`);
}

/** 任务进入 running 时调用；写失败只 warn，不影响任务本身。 */
export function markSessionCommandTaskRunning(task: {
  id: string;
  sessionId: string;
  title: string;
  shortName: string;
  createdAt: number;
}): void {
  try {
    fs.mkdirSync(markerDir(), { recursive: true });
    const marker: RunningMarker = {
      taskId: task.id,
      sessionId: task.sessionId,
      title: task.title,
      shortName: task.shortName,
      createdAt: task.createdAt,
      startedAt: Date.now(),
    };
    fs.writeFileSync(markerPath(task.id), JSON.stringify(marker));
  } catch (error) {
    logger.warn('Failed to write running marker; a restart mid-task will not be reported', {
      taskId: task.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function clearSessionCommandTaskMarker(taskId: string): void {
  try {
    fs.rmSync(markerPath(taskId), { force: true });
  } catch (error) {
    logger.warn('Failed to remove running marker', {
      taskId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * settle 落了终态、但投影因会话不可读进入延迟重试时调用：给 running 标记补一份终态快照
 * 再保留它。重试窗口内宿主退出/崩溃，下次启动的恢复按真实结局补投结果（不写中断行、
 * 不覆盖账本终态）；写失败只 warn——兜底形状保证标记仍指向该任务。
 */
export function settleSessionCommandTaskMarkerForDeferredProjection(task: {
  id: string;
  sessionId: string;
  title: string;
  shortName: string;
  createdAt: number;
  status: ResultStatus;
  resultText?: string;
  summary?: string;
  detail?: string;
}): void {
  try {
    fs.mkdirSync(markerDir(), { recursive: true });
    let base: RunningMarker = {
      taskId: task.id,
      sessionId: task.sessionId,
      title: task.title,
      shortName: task.shortName,
      createdAt: task.createdAt,
      startedAt: task.createdAt,
    };
    try {
      const existing = JSON.parse(fs.readFileSync(markerPath(task.id), 'utf8')) as RunningMarker;
      if (existing?.taskId === task.id) base = existing;
    } catch {
      // 读不到旧标记（本不该发生）：用兜底形状，宁可带上终态也不能丢
    }
    const marker: RunningMarker = {
      ...base,
      terminal: {
        status: task.status,
        resultText: task.resultText,
        summary: task.summary,
        detail: task.detail,
        settledAt: Date.now(),
      },
    };
    fs.writeFileSync(markerPath(task.id), JSON.stringify(marker));
  } catch (error) {
    logger.warn('Failed to stamp the running marker with the terminal outcome; a restart in the retry window would misread the task as interrupted', {
      taskId: task.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 正常终态与重启中断共用的「[任务结果]」系统消息形状（正文用人话状态词，metadata 保持机器可读）。 */
export function buildSessionTaskResultMessage(
  task: { id: string; shortName: string },
  status: ResultStatus,
  resultText: string | undefined,
  id: string = `session-task-result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  locale: SessionTaskResultStatusWordLocale = 'zh',
): Message {
  return {
    id,
    role: 'system',
    content: `[任务结果] ${task.shortName}｜${formatSessionTaskResultStatusWord(status, locale)}｜${resultText}`,
    timestamp: Date.now(),
    metadata: {
      backgroundTaskResult: {
        source: 'agent-result',
        taskId: task.id,
        shortName: task.shortName,
        status,
        summary: resultText ?? '',
      },
    },
  };
}

function interruptedText(locale: 'zh' | 'en'): string {
  return locale === 'zh'
    ? '应用重启时这个后台任务还没做完，已被中断，结果没能送回这里。需要的话请重新发起。'
    : 'The app restarted while this background task was still running, so it was interrupted and its result could not be delivered. Please start it again if you still need it.';
}

function resolveLocale(): 'zh' | 'en' {
  try {
    return getConfigService().getSettings().ui.language;
  } catch (error) {
    logger.warn('Failed to read UI locale for restart recovery; using Chinese fallback', {
      message: error instanceof Error ? error.message : String(error),
    });
    return 'zh';
  }
}

function readMarkers(): Array<{ file: string; marker: RunningMarker }> {
  const dir = markerDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Failed to list running markers', { message: error instanceof Error ? error.message : String(error) });
    }
    return [];
  }
  const out: Array<{ file: string; marker: RunningMarker }> = [];
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      const marker = JSON.parse(fs.readFileSync(file, 'utf8')) as RunningMarker;
      if (marker.taskId && marker.sessionId) out.push({ file, marker });
      else fs.rmSync(file, { force: true });
    } catch (error) {
      logger.warn('Dropping unreadable running marker', { file, message: error instanceof Error ? error.message : String(error) });
      fs.rmSync(file, { force: true });
    }
  }
  return out;
}

function buildInterruptedMessage(marker: RunningMarker, locale: 'zh' | 'en', text: string): Message {
  const message = buildSessionTaskResultMessage(
    { id: marker.taskId, shortName: marker.shortName },
    'failed',
    text,
    `session-task-result-interrupted-${marker.taskId}`,
    locale,
  );
  message.metadata = { ...message.metadata, backgroundTaskInterrupted: { taskId: marker.taskId } };
  return message;
}

async function writeInterruptedMessage(marker: RunningMarker, locale: 'zh' | 'en', text: string): Promise<void> {
  await getSessionManager().addMessageToSession(marker.sessionId, buildInterruptedMessage(marker, locale, text));
}

function writeInterruptedLedgerRow(
  ledger: ReturnType<typeof getBackgroundTaskLedger>,
  marker: RunningMarker,
  text: string,
): void {
  try {
    const now = Date.now();
    ledger.upsertTask({
      id: marker.taskId,
      kind: 'session_command_task',
      source: 'session_command_center',
      sessionId: marker.sessionId,
      runId: marker.taskId,
      title: marker.title,
      summary: text,
      status: 'failed',
      createdAt: marker.createdAt,
      updatedAt: now,
      startedAt: marker.startedAt,
      completedAt: now,
      failure: { message: text, reason: SESSION_COMMAND_TASK_INTERRUPTED_REASON },
      metadata: { shortName: marker.shortName, childRunId: marker.taskId },
    });
  } catch (error) {
    logger.warn('Restart recovery could not record the ledger row', {
      taskId: marker.taskId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function writeDeferredTerminalResultMessage(
  marker: RunningMarker,
  terminal: NonNullable<RunningMarker['terminal']>,
  locale: 'zh' | 'en',
): Promise<void> {
  await getSessionManager().addMessageToSession(
    marker.sessionId,
    buildSessionTaskResultMessage(
      { id: marker.taskId, shortName: marker.shortName },
      terminal.status,
      terminal.resultText ?? terminal.summary,
      `session-task-result-${marker.taskId}`,
      locale,
    ),
  );
}

/**
 * 带终态快照的标记（settle 已收口、只是投影被会话不可读挡住时宿主又退出了）：
 * 补投**真实结局**的结果行——不写中断句、不带 backgroundTaskInterrupted、不把账本
 * 终态覆盖成 failed。账本行 settle 当时已写过，只有账本里没有这行（store 曾缺席的
 * 窗口）才按快照补一份精简行。
 */
async function recoverDeferredTerminalResult(
  ledger: ReturnType<typeof getBackgroundTaskLedger>,
  file: string,
  marker: RunningMarker,
  locale: 'zh' | 'en',
): Promise<void> {
  const terminal = marker.terminal;
  if (!terminal) return;
  try {
    if (!ledger.getTask(marker.taskId)) {
      ledger.upsertTask({
        id: marker.taskId,
        kind: 'session_command_task',
        source: 'session_command_center',
        sessionId: marker.sessionId,
        runId: marker.taskId,
        title: marker.title,
        summary: terminal.summary ?? terminal.resultText ?? '',
        status: terminal.status,
        createdAt: marker.createdAt,
        updatedAt: terminal.settledAt,
        startedAt: marker.startedAt,
        completedAt: terminal.settledAt,
        ...(terminal.status === 'failed' && terminal.detail
          ? { failure: { message: terminal.detail, reason: 'session_command_task_failed' } }
          : {}),
        metadata: { shortName: marker.shortName, childRunId: marker.taskId },
      });
    }
  } catch (error) {
    logger.warn('Restart recovery could not backfill the settled ledger row', {
      taskId: marker.taskId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await writeDeferredTerminalResultMessage(marker, terminal, locale);
  } catch (error) {
    if (isSessionNotAccessibleError(error)) {
      logger.warn('Restart recovery waiting: session not accessible for current owner; settled result message deferred', {
        reason: 'terminal_result_message_not_accessible_for_current_owner',
        taskId: marker.taskId,
        sessionId: marker.sessionId,
      });
      createSessionAccessRetry({
        reasonKey: 'terminal_result_message',
        attemptsUsed: 1,
        logContext: { taskId: marker.taskId, sessionId: marker.sessionId },
        attempt: () => writeDeferredTerminalResultMessage(marker, terminal, locale),
        onExhausted: () => {
          logger.warn('Restart recovery gave up retrying the settled result message in this process; marker kept for the next start', {
            reason: 'terminal_result_message_not_accessible_retries_exhausted',
            taskId: marker.taskId,
            sessionId: marker.sessionId,
          });
        },
        onSettled: (outcome) => {
          if (outcome !== 'written') return;
          fs.rmSync(file, { force: true });
        },
        logger,
      }).start();
      return;
    }
    logger.warn('Restart recovery could not re-project the settled task result', {
      reason: 'terminal_result_message_write_failed',
      taskId: marker.taskId,
      sessionId: marker.sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
    fs.rmSync(file, { force: true });
    return;
  }
  fs.rmSync(file, { force: true });
  logger.warn('Session command task result re-projected after restart; terminal outcome preserved', {
    taskId: marker.taskId,
    sessionId: marker.sessionId,
    status: terminal.status,
  });
}

/**
 * 中断消息写不进去是因为会话对当前 owner 不可读（登录恢复中）：标记必须留下——
 * 删了就等于把中断报告一起删了。本进程内按同一组界重试（定时器 + 登录态信号），
 * 耗尽后也不删：下次启动 readMarkers 还能看到它，再试一轮。
 */
function deferInterruptedMessageUntilAccessible(input: {
  marker: RunningMarker;
  file: string;
  locale: 'zh' | 'en';
  text: string;
}): void {
  createSessionAccessRetry({
    reasonKey: 'interruption_message',
    attemptsUsed: 1,
    logContext: { taskId: input.marker.taskId, sessionId: input.marker.sessionId },
    attempt: () => writeInterruptedMessage(input.marker, input.locale, input.text),
    onExhausted: () => {
      logger.warn('Restart recovery gave up retrying the interruption message in this process; marker kept for the next start', {
        reason: 'interruption_message_not_accessible_retries_exhausted',
        taskId: input.marker.taskId,
        sessionId: input.marker.sessionId,
      });
    },
    onSettled: (outcome) => {
      if (outcome !== 'written') return;
      fs.rmSync(input.file, { force: true });
      logger.warn('Session command task interrupted by app restart; failure message written', {
        taskId: input.marker.taskId,
        sessionId: input.marker.sessionId,
      });
    },
    logger,
  }).start();
}

/**
 * 启动期（DB 就绪后）调用：每个遗留标记补一条 failed 的 [任务结果] 消息 + 账本终态行，再删标记。
 * 幂等：消息 id 由 taskId 派生（重复写走 addMessage 的幂等分支），标记删了第二次启动什么都不写。
 * 会话对当前 owner 不可读（登录恢复窗口）时：账本行照写（它不经过会话可达性检查），
 * 标记保留并重试，绝不像旧代码那样直接删掉。返回本次补写成功的任务数。
 */
export async function recoverInterruptedSessionCommandTasks(): Promise<number> {
  const markers = readMarkers();
  if (markers.length === 0) return 0;
  const locale = resolveLocale();
  const text = interruptedText(locale);
  const ledger = getBackgroundTaskLedger();
  try {
    const db = getDatabase().getDb();
    if (db) ledger.setStore(new SqliteBackgroundTaskStore(db));
  } catch (error) {
    logger.warn('Background task store unavailable during restart recovery; ledger rows stay in memory', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  let recovered = 0;
  for (const { file, marker } of markers) {
    if (marker.terminal) {
      // settle 已收口的任务：重启恢复补投真实结局，绝不走中断分支（会把 completed 改写成 failed）。
      await recoverDeferredTerminalResult(ledger, file, marker, locale);
      continue;
    }
    // 账本终态行不依赖会话可读：无论消息写成写不成都先落，别让侧栏永远「运行中」。
    writeInterruptedLedgerRow(ledger, marker, text);
    try {
      await writeInterruptedMessage(marker, locale, text);
    } catch (error) {
      if (isSessionNotAccessibleError(error)) {
        logger.warn('Restart recovery waiting: session not accessible for current owner; interruption message deferred', {
          reason: 'interruption_message_not_accessible_for_current_owner',
          taskId: marker.taskId,
          sessionId: marker.sessionId,
        });
        deferInterruptedMessageUntilAccessible({ marker, file, locale, text });
        continue;
      }
      logger.warn('Restart recovery could not write the interruption message', {
        reason: 'interruption_message_write_failed',
        taskId: marker.taskId,
        sessionId: marker.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      fs.rmSync(file, { force: true });
      continue;
    }
    fs.rmSync(file, { force: true });
    recovered += 1;
    logger.warn('Session command task interrupted by app restart; failure message written', {
      taskId: marker.taskId,
      sessionId: marker.sessionId,
    });
  }
  return recovered;
}
