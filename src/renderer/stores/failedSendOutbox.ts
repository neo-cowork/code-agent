import type { Message } from '@shared/contract';
import { sanitizeAttachmentsForPersistence } from '@shared/utils/messageAttachments';
import { createLogger } from '../utils/logger';

const logger = createLogger('FailedSendOutbox');
const keyPrefix = 'neo-failed-send-outbox:';
type FailedTurn = { sessionId: string; user: Message; error: Message };
// Keep switching usable even when persistence is unavailable (private mode/quota).
const memory = new Map<string, FailedTurn[]>();

function storageFailure(error: unknown): void {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  logger.warn('Failed send outbox persistence failed', {
    reason: name === 'QuotaExceededError' ? 'quota exceeded' : 'storage unavailable',
  });
}

function isMessage(value: unknown, role: Message['role']): value is Message {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<Message>;
  return message.role === role && typeof message.id === 'string' && message.id.length > 0
    && typeof message.content === 'string' && typeof message.timestamp === 'number'
    && (message.attachments === undefined || (Array.isArray(message.attachments)
      && message.attachments.every((attachment) => attachment && typeof attachment.name === 'string'
        && typeof attachment.id === 'string' && (attachment.type === 'file' || attachment.type === 'image'))));
}

function read(sessionId: string): FailedTurn[] | undefined {
  const cached = memory.get(sessionId);
  if (cached) return cached;
  let raw: string | null;
  try {
    raw = localStorage.getItem(keyPrefix + sessionId);
  } catch (error) {
    storageFailure(error);
    return memory.get(sessionId);
  }
  if (raw === null) return memory.get(sessionId);
  try {
    const parsed: unknown = JSON.parse(raw);
    // Older clients stored one turn directly under the same session key.
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const turns = new Map<string, FailedTurn>();
    for (const value of entries) {
      const entry = value as Partial<FailedTurn> | null;
      if (typeof entry?.sessionId === 'string' && entry.sessionId !== sessionId) {
        logger.warn('Failed send outbox entry rejected', { reason: 'session mismatch' });
        continue;
      }
      if (entry?.sessionId !== sessionId || !isMessage(entry.user, 'user')
        || !isMessage(entry.error, 'assistant') || entry.user.metadata?.sendFailed !== true
        || entry.error.metadata?.retryClientMessageId !== entry.user.id) {
        logger.warn('Failed send outbox entry rejected', { reason: 'unparsable entry' });
        continue;
      }
      if (entry.error.metadata?.retrySessionId !== sessionId) {
        logger.warn('Failed send outbox entry rejected', { reason: 'session mismatch' });
        continue;
      }
      turns.set(entry.user.id, entry as FailedTurn);
    }
    const result = [...turns.values()];
    memory.set(sessionId, result);
    return result;
  } catch {
    logger.warn('Failed send outbox entry rejected', { reason: 'unparsable entry' });
    return undefined;
  }
}

// 整图 data URL 动辄数 MB，直接 JSON 进 localStorage 会超配额，刷新后整条失败轮次连图带字一起丢。
// 落盘只存与 DB 同口径的瘦身附件（大图去掉内联数据、保留文件名卡片）；内存里仍是完整副本。
function toStorable(entry: FailedTurn): FailedTurn {
  const retryAttachments = entry.error.metadata?.retryAttachments;
  return {
    ...entry,
    user: entry.user.attachments
      ? { ...entry.user, attachments: sanitizeAttachmentsForPersistence(entry.user.attachments) }
      : entry.user,
    error: retryAttachments
      ? { ...entry.error, metadata: { ...entry.error.metadata, retryAttachments: sanitizeAttachmentsForPersistence(retryAttachments) } }
      : entry.error,
  };
}

function write(sessionId: string, entries: FailedTurn[]): void {
  if (entries.length) memory.set(sessionId, entries);
  else memory.delete(sessionId);
  try {
    if (entries.length) localStorage.setItem(keyPrefix + sessionId, JSON.stringify(entries.map(toStorable)));
    else localStorage.removeItem(keyPrefix + sessionId);
  } catch (error) {
    memory.set(sessionId, entries);
    storageFailure(error);
  }
}

export function recordFailedSend(sessionId: string, user: Message, error: Message): void {
  const entry: FailedTurn = {
    sessionId,
    user: { ...user, metadata: { ...user.metadata, sendFailed: true } },
    error,
  };
  const entries = [...(read(sessionId) ?? [])];
  const index = entries.findIndex((turn) => turn.user.id === user.id);
  if (index < 0) entries.push(entry);
  else entries[index] = entry;
  write(sessionId, entries);
}

/** Clear only the accepted client ID; accepting another turn must not lose this one. */
export function clearFailedSend(sessionId: string, clientMessageId?: string): void {
  if (!clientMessageId) {
    write(sessionId, []);
    return;
  }
  const entries = read(sessionId);
  if (!entries?.some((entry) => entry.user.id === clientMessageId)) return;
  write(sessionId, entries.filter((entry) => entry.user.id !== clientMessageId));
}

export function mergeFailedSendOutbox(sessionId: string, messages: Message[], persisted: Message[]): Message[] {
  const entries = read(sessionId);
  if (!entries?.length) return messages;
  const storedUsers = new Map(persisted.filter((message) => message.role === 'user')
    .map((message) => [message.id, message]));
  const remaining = entries.filter((entry) => !storedUsers.has(entry.user.id));
  if (remaining.length !== entries.length) write(sessionId, remaining);
  const errorIds = new Set(entries.map((entry) => entry.error.id));
  const pendingUserIds = new Set(remaining.map((entry) => entry.user.id));
  // A force reload may retain an optimistic copy; persisted user IDs belong to the DB.
  const merged = messages.filter((message) => !errorIds.has(message.id) && !pendingUserIds.has(message.id))
    .map((message) => storedUsers.get(message.id) ?? message);
  // Insert whole pairs so a confirmation prompt stays beside its user message,
  // including when multiple sends share a millisecond timestamp.
  const restoredIds = new Set(remaining.flatMap((entry) => [entry.user.id, entry.error.id]));
  for (const entry of [...remaining].sort((a, b) => a.user.timestamp - b.user.timestamp)) {
    const index = merged.findIndex((message) => !restoredIds.has(message.id) && message.timestamp > entry.user.timestamp);
    merged.splice(index < 0 ? merged.length : index, 0, entry.user, entry.error);
  }
  return merged;
}
