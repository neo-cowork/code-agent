// ============================================================================
// offlineSend — 离线发送识别、一次性自动重放保护与跨层信号
// ============================================================================
// Surface A（无气泡、草稿回滚）与 Surface B（失败气泡 + failedSendOutbox）
// 共用同一套「只因后台不可达而失败」判据和「恢复后自动重放一次」护栏。
// ============================================================================

import type { Message } from '@shared/contract';
import { getServerConnectionStatus, useServerConnectionStore } from '../stores/serverConnectionStore';
import { getServerReconnectingMessage } from './serverConnectionMonitor';

export const OFFLINE_SEND_PENDING_CODE = 'SEND_OFFLINE_PENDING';
export const OFFLINE_SEND_FAILED_CODE = 'SEND_OFFLINE_FAILED';

export type OfflineAutoReplaySurface = 'composer' | 'outbox';

const NETWORK_TYPE_ERROR_RE = /failed to fetch|load failed|networkerror|fetch failed/i;

/** 识别真正的「连不上 Neo 后台」传输故障（不含 HTTP 4xx/5xx 业务错误或普通 Error）。 */
export function isOfflineTransportError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; status?: unknown; message?: unknown };
  if (typeof record.status === 'number' && record.status > 0) return false;
  if (record.code === 'NETWORK_ERROR') return true;
  if (error instanceof Error) {
    const msg = error.message.trim();
    if (msg && msg === getServerReconnectingMessage()) return true;
    if (error instanceof TypeError && NETWORK_TYPE_ERROR_RE.test(msg)) return true;
  }
  return false;
}

/** 当前是否已知后台不可达（连接监视器非 ok 或浏览器明确 offline）。 */
export function isBackendCurrentlyOffline(): boolean {
  if (getServerConnectionStatus() !== 'ok') return true;
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// Surface A 预检返回 false 时记下「这一次是离线导致的」，供 useChatInputSubmit 区分离线与普通拦截。
const lastOfflineSendFailures = new Set<string>();
const LAST_OFFLINE_ANY_KEY = '__any__';

export function markLastSendOfflineFailure(clientMessageId?: string): void {
  lastOfflineSendFailures.add(clientMessageId || LAST_OFFLINE_ANY_KEY);
}

export function consumeLastSendOfflineFailure(clientMessageId?: string): boolean {
  if (clientMessageId && lastOfflineSendFailures.delete(clientMessageId)) {
    lastOfflineSendFailures.delete(LAST_OFFLINE_ANY_KEY);
    return true;
  }
  return lastOfflineSendFailures.delete(LAST_OFFLINE_ANY_KEY);
}

// 自动重放在途表：同页期间标记正在重放的 clientMessageId，既给卡片显示「正在发送…」，
// 也防止自动重放失败后再次自我武装成死循环。
const activeAutoReplays = new Map<string, OfflineAutoReplaySurface>();
const replayListeners = new Set<() => void>();

function notifyReplayListeners(): void {
  replayListeners.forEach((listener) => listener());
}

export function markOfflineAutoReplayAttempt(
  clientMessageId: string,
  surface: OfflineAutoReplaySurface,
): void {
  activeAutoReplays.set(clientMessageId, surface);
  notifyReplayListeners();
}

export function getOfflineAutoReplaySurface(
  clientMessageId: string,
): OfflineAutoReplaySurface | null {
  return activeAutoReplays.get(clientMessageId) ?? null;
}

export function finishOfflineAutoReplayAttempt(clientMessageId: string): void {
  if (activeAutoReplays.delete(clientMessageId)) {
    notifyReplayListeners();
  }
}

export function isOfflineAutoReplayingId(clientMessageId?: string): boolean {
  return Boolean(clientMessageId && activeAutoReplays.has(clientMessageId));
}

export function subscribeOfflineAutoReplaying(listener: () => void): () => void {
  replayListeners.add(listener);
  return () => {
    replayListeners.delete(listener);
  };
}

// 同页内记录 Surface B 离线失败当刻的 eventStreamRevision：
// - 同页未刷新：必须等 revision 真正推进才触发重放（防刚失败就立刻重放）；
// - 刷新后新 JS 堆：此 Map 为空，挂载且可达（eventStreamRevision >= 1）即可触发一次重放。
const outboxFailureRevisions = new Map<string, number>();

function outboxKey(sessionId: string, clientMessageId: string): string {
  return `${sessionId}:${clientMessageId}`;
}

export function noteOfflineOutboxFailureRevision(
  sessionId: string,
  clientMessageId: string,
  revision: number,
): void {
  outboxFailureRevisions.set(outboxKey(sessionId, clientMessageId), revision);
}

export function getOfflineOutboxFailureRevision(
  sessionId: string,
  clientMessageId: string,
): number | undefined {
  return outboxFailureRevisions.get(outboxKey(sessionId, clientMessageId));
}

export function clearOfflineOutboxFailureRevision(
  sessionId: string,
  clientMessageId: string,
): void {
  outboxFailureRevisions.delete(outboxKey(sessionId, clientMessageId));
}

/** 发送成功后移除同一条用户消息遗留的离线等待/重试卡片（保持时间线干净）。 */
export function stripStaleOfflineErrorMessages(messages: Message[], clientMessageId: string): Message[] {
  return messages.filter((message) => !(
    message.role === 'assistant'
    && message.metadata?.retryClientMessageId === clientMessageId
    && (message.metadata?.sendFailureCode === OFFLINE_SEND_PENDING_CODE
      || message.metadata?.sendFailureCode === OFFLINE_SEND_FAILED_CODE)
  ));
}

/** 判定 sendMessage 失败时是否归入离线等待卡或自动重放失败卡。 */
export function resolveOfflineSendFailureCode(params: {
  error: unknown;
  hasAttachments: boolean;
  replaySurface: OfflineAutoReplaySurface | null;
  fallbackCode: string;
}): string {
  const { error, hasAttachments, replaySurface, fallbackCode } = params;
  if (replaySurface === 'outbox') return OFFLINE_SEND_FAILED_CODE;
  if (isOfflineTransportError(error) && !hasAttachments) return OFFLINE_SEND_PENDING_CODE;
  return fallbackCode;
}

export function isOfflineSendFailureCode(code: string): boolean {
  return code === OFFLINE_SEND_PENDING_CODE || code === OFFLINE_SEND_FAILED_CODE;
}

/** 登记 Surface B 离线挂起气泡当刻的 eventStreamRevision。 */
export function recordOfflineOutboxPendingRevisionIfNeeded(
  sessionId: string | undefined,
  clientMessageId: string,
  sendFailureCode: string,
): void {
  if (sessionId && sendFailureCode === OFFLINE_SEND_PENDING_CODE) {
    noteOfflineOutboxFailureRevision(
      sessionId,
      clientMessageId,
      useServerConnectionStore.getState().eventStreamRevision,
    );
  }
}
