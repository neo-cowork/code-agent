// ============================================================================
// Runtime the task needs is missing（ADR-090 §3 row 7 — N-ENV-ASSIST-S5-RUNTIME）
//
// Neo 自己装运行时（今天只有 LibreOffice）时聊天里的那一张卡：一个 (run, 目标) 一张、原地更新——
//   fixing + 百分比 → resolved；装失败 → needs_user，只留一个「重试安装」按钮（recheck）。
// 安装状态（getLibreOfficeState）是唯一事实源：卡上的相位和百分比都从它读出来，这里不弹任何系统框。
// 进度发布器独立于 env-resume 等待者：停不了车的 run（子代理、非持久宿主）同样要看得到进度。
// ============================================================================

import type { Message } from '../../../shared/contract';
import type { EnvAssistNotice } from '../../../shared/contract/envAssist';
import { ENV_RESUME_RUNTIME_STALL_MS, ENV_RUNTIME_PROGRESS_INTERVAL_MS } from '../../../shared/constants/envResume';
import { peekEnvBlockedNote } from '../../agent/runtime/envBlockedTurn';
import { emitExternalAgentEvent } from '../../services/agentEngine/agentEngineEventSink';
import { getSessionManager } from '../../services/infra/sessionManager';
import { createLogger } from '../../services/infra/logger';
import { ensureLibreOffice } from '../../runtime/libreOffice/ensure';
import { getLibreOfficeState } from '../../runtime/libreOffice/state';
import type { LibreOfficeState } from '../../runtime/libreOffice/types';
import type { EnvResumeProbe } from '../../runtime/envResumeWaiter';
import { queueNoticeWrite } from './noticeWriteQueue';

const RUNTIME_TARGET = 'libreoffice';
const RUNTIME_CODES = /^LIBREOFFICE_RUNTIME_/;
const logger = createLogger('EnvRuntimeNotice');

/** The blocker behind a failed tool result when it is a runtime Neo installs: the run's park note, or the shell hook's code. */
export function runtimeBlockerFor(input: {
  toolName: string; result: { success?: boolean; metadata?: unknown }; runId?: string; parkedToolCallId?: string;
}): { target: string } | null {
  if (input.parkedToolCallId) {
    const note = peekEnvBlockedNote(input.runId);
    if (note?.class === 'runtime_missing') return { target: note.target };
  }
  if (input.toolName !== 'Bash' || input.result.success !== false) return null;
  const code = (input.result.metadata as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && RUNTIME_CODES.test(code) ? { target: RUNTIME_TARGET } : null;
}

export function isRuntimeNotice(notice: EnvAssistNotice): boolean {
  return notice.class === 'runtime_missing';
}

/** The card as the install state says it is right now. Pure: the caller decides whether to store it. */
export function runtimeNoticeFor(input: {
  sessionId: string; runId: string; target: string; parkedToolCallId?: string; now?: number; state?: LibreOfficeState;
}): EnvAssistNotice {
  const state = input.state ?? getLibreOfficeState();
  const base = {
    id: `${input.runId}|runtime_missing|${input.target}`,
    sessionId: input.sessionId, runId: input.runId, class: 'runtime_missing' as const,
    target: { id: input.target, labelKey: `env.target.${input.target}` },
    resume: { mode: 'auto' as const }, updatedAt: input.now ?? Date.now(),
    ...(input.parkedToolCallId ? { parkedToolCallId: input.parkedToolCallId } : {}),
  };
  if (state.phase === 'installed') return { ...base, phase: 'resolved', sentenceKey: `env.sentence.${input.target}Ready`, doneKey: `env.done.${input.target}` };
  if (state.phase === 'failed') {
    const offline = state.error?.code === 'LIBREOFFICE_RUNTIME_OFFLINE';
    return {
      ...base, phase: 'needs_user', sentenceKey: `env.sentence.${input.target}${offline ? 'Offline' : 'Failed'}`,
      action: { kind: 'recheck', labelKey: `env.retry.${input.target}` },
    };
  }
  if (state.phase === 'unsupported') return { ...base, phase: 'unsupported', sentenceKey: `env.sentence.${input.target}Unsupported` };
  return {
    ...base, phase: 'fixing', sentenceKey: `env.sentence.${input.target}Preparing`,
    sentenceParams: { percent: Math.round(state.percent ?? 0) }, progress: { percent: Math.round(state.percent ?? 0) },
  };
}

/** What the model reads in place of the failed command (the user reads the card). */
export function runtimeModelGuidance(notice: EnvAssistNotice): string {
  const common = 'Model guidance (not user copy): A card for the missing component has already been shown to the user. '
    + 'Do not repeat or quote this guidance, error text, tool names, commands, or internal status labels, including in a delegated summary. ';
  if (notice.phase === 'fixing' && !notice.parkedToolCallId) {
    // A run that cannot wait (a background helper, a non-durable host) is not resumed when the install lands.
    return common + 'The card has no button and shows the progress. In one short sentence in the user\'s language, say that a one-time component '
      + 'is being prepared and that the conversion has not been done yet. Do not claim you will continue on your own. Do not describe what is being downloaded or how.';
  }
  if (notice.phase === 'fixing') {
    return common + 'The card has no button. In one short sentence in the user\'s language, say that a one-time component is being prepared '
      + 'and that the task continues by itself once it is ready. Do not describe what is being downloaded or how.';
  }
  if (notice.phase === 'needs_user') {
    return common + 'The card has a retry button. In one short sentence in the user\'s language, say that the component could not be set up and that '
      + 'the user can press the retry button on the card. You may keep going with a route that does not need document conversion. '
      + 'Do not claim you will continue on your own once it works.';
  }
  return common + 'The card has no button. In one short sentence in the user\'s language, say that document conversion is not available here. '
    + 'Do not claim you will check or continue on your own.';
}

/**
 * Persist the card where it already lives and tell open windows. A stale progress tick must not undo a card that
 * already resolved or asked the user; only an explicit retry may put such a card back to "preparing".
 */
async function writeRuntimeNotice(next: EnvAssistNotice, options: { retry?: boolean } = {}): Promise<void> {
  await queueNoticeWrite(next, async () => {
    const manager = getSessionManager();
    const messageId = `env-assist:${next.id}`;
    const persisted = (await manager.getMessages(next.sessionId)).find((m) => m.id === messageId);
    if (!persisted) return;
    const current = persisted.metadata?.envAssist;
    if (!options.retry && current && (current.updatedAt > next.updatedAt || (current.phase !== 'fixing' && next.phase === 'fixing'))) return;
    await manager.addMessageToSession(next.sessionId, { ...persisted, metadata: { ...persisted.metadata, envAssist: next } });
    emitExternalAgentEvent(next.sessionId, { type: 'env_assist_notice', data: next });
  });
}

interface Follower { notice: EnvAssistNotice; changedAt: number }
const followers = new Map<string, Follower>();
let tick: ReturnType<typeof setTimeout> | undefined;
let stallTimer: ReturnType<typeof setTimeout> | undefined;
let kickRequested = false;
let publishing = false;

function kickInstall(reason: string): void {
  if (process.env.CODE_AGENT_NO_RUNTIME_AUTOINSTALL === '1') return;
  logger.info('LibreOffice install (re)started', { reason });
  void ensureLibreOffice().then(
    (result) => { if (!result.ok) logger.warn('LibreOffice install failed', { reason: 'install_failed', code: result.error.code }); },
    (error: unknown) => { logger.warn('LibreOffice install threw', { reason: 'install_threw', error: error instanceof Error ? error.message : String(error) }); },
  );
}

/** No progress for the whole stall window: say so and hand the user the one button (same rule as the waiter). */
async function stallOut(): Promise<void> {
  const waiting = [...followers.values()].filter((follower) => follower.notice.phase === 'fixing');
  followers.clear();
  for (const { notice, changedAt } of waiting) {
    const target = notice.target?.id ?? RUNTIME_TARGET;
    logger.warn('LibreOffice install made no progress; asking the user', { noticeId: notice.id, stallMs: ENV_RESUME_RUNTIME_STALL_MS, since: changedAt });
    await writeRuntimeNotice({
      ...notice, phase: 'needs_user', sentenceKey: `env.sentence.${target}Stalled`, action: { kind: 'recheck', labelKey: `env.retry.${target}` },
      progress: undefined, sentenceParams: undefined, updatedAt: Date.now(),
    });
  }
}

/** The stall window starts over on every progress change, exactly like the waiter's. */
function rearmStall(): void {
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = setTimeout(() => { stallTimer = undefined; void stallOut(); }, ENV_RESUME_RUNTIME_STALL_MS);
  stallTimer.unref?.();
}

async function publishTick(): Promise<void> {
  tick = undefined;
  if (publishing) return;
  publishing = true;
  try {
    const state = getLibreOfficeState();
    const now = Date.now();
    // An install that died with its process (kill -9 mid-download): a card still waiting is the user asking for it again.
    if (state.phase === 'missing' && !kickRequested) { kickRequested = true; kickInstall('card_still_waiting'); }
    for (const [id, follower] of [...followers]) {
      const { notice } = follower;
      const next = runtimeNoticeFor({
        sessionId: notice.sessionId, runId: notice.runId, target: notice.target?.id ?? RUNTIME_TARGET,
        parkedToolCallId: notice.parkedToolCallId, now, state,
      });
      if (next.phase !== 'fixing') {
        followers.delete(id);
        await writeRuntimeNotice(next);
        continue;
      }
      if (next.progress?.percent === notice.progress?.percent) continue;
      followers.set(id, { notice: next, changedAt: now });
      rearmStall();
      await writeRuntimeNotice(next);
    }
  } finally { publishing = false; }
  if (followers.size > 0) {
    tick = setTimeout(() => { void publishTick(); }, ENV_RUNTIME_PROGRESS_INTERVAL_MS);
    tick.unref?.();
  } else {
    kickRequested = false;
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = undefined; }
  }
}

/** Keep a "preparing" card current while the install runs. Idempotent per card. */
export function followRuntimeInstall(notice: EnvAssistNotice): void {
  if (notice.phase !== 'fixing') return;
  followers.set(notice.id, { notice, changedAt: Date.now() });
  if (tick === undefined) {
    rearmStall();
    tick = setTimeout(() => { void publishTick(); }, ENV_RUNTIME_PROGRESS_INTERVAL_MS);
    tick.unref?.();
  }
}

/** The card's "Retry install" click: start the install again, put the card back to "preparing", follow it. */
export async function retryRuntimeInstall(notice: EnvAssistNotice): Promise<EnvAssistNotice> {
  kickRequested = true;
  kickInstall('retry_clicked');
  // The new attempt registers before ensureLibreOffice returns, so the card reads "preparing" again at once.
  const next = runtimeNoticeFor({
    sessionId: notice.sessionId, runId: notice.runId, target: notice.target?.id ?? RUNTIME_TARGET,
    parkedToolCallId: notice.parkedToolCallId, now: Date.now(),
  });
  await writeRuntimeNotice(next, { retry: true });
  followRuntimeInstall(next);
  return next;
}

/**
 * Passive read for the env-resume waiter. An install that died with the process is started again (single flight);
 * the parked run's card is followed again so it keeps showing progress after a restart.
 * On terminal states (installed / failed / unsupported), sync the card first so the user sees "ready" / "retry"
 * before the resumed turn starts or the waiter exits (no race with the 1 s progress ticker).
 */
export function libreOfficeResumeProbe(scope?: { runId: string; sessionId: string }): EnvResumeProbe {
  let refollowed = false;
  return async () => {
    const state = getLibreOfficeState();
    if (state.phase === 'installed') {
      if (scope) await syncScopeNotice(scope, state);
      return 'green';
    }
    if (state.phase === 'unsupported') {
      if (scope) await syncScopeNotice(scope, state);
      return 'unavailable';
    }
    if (state.phase === 'failed') {
      if (scope) await syncScopeNotice(scope, state);
      return 'failed';
    }
    if (!refollowed) {
      refollowed = true;
      if (state.phase === 'missing') { kickRequested = true; kickInstall('resume_probe'); }
      if (scope) void refollow(scope);
    }
    return { status: 'red', progress: state.phase === 'installing' ? Math.round(state.percent ?? 0) : undefined };
  };
}

async function syncScopeNotice(scope: { runId: string; sessionId: string }, state: LibreOfficeState): Promise<void> {
  try {
    const messages = await getSessionManager().getMessages(scope.sessionId);
    const notice = messages.findLast((message: Message) => message.metadata?.envAssist?.runId === scope.runId
      && message.metadata.envAssist.class === 'runtime_missing')?.metadata?.envAssist;
    if (notice?.phase !== 'fixing') return;
    followers.delete(notice.id);
    const next = runtimeNoticeFor({
      sessionId: notice.sessionId, runId: notice.runId, target: notice.target?.id ?? RUNTIME_TARGET,
      parkedToolCallId: notice.parkedToolCallId, now: Date.now(), state,
    });
    if (next.phase !== 'fixing') await writeRuntimeNotice(next);
  } catch (error) {
    logger.warn('Runtime card terminal sync failed', { runId: scope.runId, error: error instanceof Error ? error.message : String(error) });
  }
}

async function refollow(scope: { runId: string; sessionId: string }): Promise<void> {
  try {
    const messages = await getSessionManager().getMessages(scope.sessionId);
    const notice = messages.findLast((message: Message) => message.metadata?.envAssist?.runId === scope.runId
      && message.metadata.envAssist.class === 'runtime_missing')?.metadata?.envAssist;
    if (!notice) { logger.warn('Runtime card not found for a parked run', { reason: 'no_notice', runId: scope.runId }); return; }
    if (notice.phase !== 'fixing') { logger.info('Runtime card is not waiting any more', { reason: 'phase_' + notice.phase, noticeId: notice.id }); return; }
    followRuntimeInstall(notice);
  } catch (error) {
    logger.warn('Runtime card could not be followed again', { reason: 'read_failed', error: error instanceof Error ? error.message : String(error) });
  }
}

/** A card re-mounted (page reload) asks for its current copy; passively sync and re-follow a card that still says "preparing". */
export async function recheckRuntimeNotice(notice: EnvAssistNotice): Promise<EnvAssistNotice> {
  if (notice.phase !== 'fixing') return notice;
  const next = runtimeNoticeFor({
    sessionId: notice.sessionId, runId: notice.runId, target: notice.target?.id ?? RUNTIME_TARGET,
    parkedToolCallId: notice.parkedToolCallId, now: Date.now(),
  });
  if (next.phase !== notice.phase || next.progress?.percent !== notice.progress?.percent) {
    await writeRuntimeNotice(next);
  }
  if (next.phase === 'fixing') followRuntimeInstall(next);
  return next;
}
