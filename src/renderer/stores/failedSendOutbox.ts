import type { Message } from '@shared/contract';
import { createLogger } from '../utils/logger';

const logger = createLogger('FailedSendOutbox');
const keyPrefix = 'neo-failed-send-outbox:';
type FailedTurn = { sessionId: string; user: Message; error: Message };
// Keep switching usable even when persistence is unavailable (private mode/quota).
const memory = new Map<string, FailedTurn>();

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

function read(sessionId: string): FailedTurn | undefined {
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
    const entry = JSON.parse(raw) as Partial<FailedTurn> | null;
    if (typeof entry?.sessionId === 'string' && entry.sessionId !== sessionId) {
      logger.warn('Failed send outbox entry rejected', { reason: 'session mismatch' });
      return undefined;
    }
    if (entry?.sessionId !== sessionId || !isMessage(entry.user, 'user')
      || !isMessage(entry.error, 'assistant') || entry.user.metadata?.sendFailed !== true
      || entry.error.metadata?.retryClientMessageId !== entry.user.id) {
      logger.warn('Failed send outbox entry rejected', { reason: 'unparsable entry' });
      return undefined;
    }
    if (entry.error.metadata?.retrySessionId !== sessionId) {
      logger.warn('Failed send outbox entry rejected', { reason: 'session mismatch' });
      return undefined;
    }
    const turn = entry as FailedTurn;
    memory.set(sessionId, turn);
    return turn;
  } catch {
    logger.warn('Failed send outbox entry rejected', { reason: 'unparsable entry' });
    return undefined;
  }
}

export function recordFailedSend(sessionId: string, user: Message, error: Message): void {
  const entry: FailedTurn = {
    sessionId,
    user: { ...user, metadata: { ...user.metadata, sendFailed: true } },
    error,
  };
  memory.set(sessionId, entry);
  try {
    localStorage.setItem(keyPrefix + sessionId, JSON.stringify(entry));
  } catch (error) {
    storageFailure(error);
  }
}

/** Clear only the accepted client ID; accepting another turn must not lose this one. */
export function clearFailedSend(sessionId: string, clientMessageId?: string): void {
  if (clientMessageId && read(sessionId)?.user.id !== clientMessageId) return;
  memory.delete(sessionId);
  try {
    localStorage.removeItem(keyPrefix + sessionId);
  } catch (error) {
    storageFailure(error);
  }
}

export function mergeFailedSendOutbox(sessionId: string, messages: Message[], persisted: Message[]): Message[] {
  const entry = read(sessionId);
  if (!entry) return messages;
  const storedUser = persisted.find((message) => message.id === entry.user.id);
  if (storedUser) {
    clearFailedSend(sessionId);
    // force reload can have retained the optimistic copy; the DB owns this ID now.
    return messages.filter((message) => message.id !== entry.error.id)
      .map((message) => message.id === storedUser.id ? storedUser : message);
  }
  const ids = new Set([entry.user.id, entry.error.id]);
  return [...messages.filter((message) => !ids.has(message.id)), entry.user, entry.error];
}
