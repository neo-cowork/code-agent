import { randomUUID } from 'node:crypto';
import { SCHEDULE_DRAFT_ACK_TIMEOUT_MS } from '../../shared/constants/timeouts';
import type { ScheduleDraftAck, ScheduleDraftRequest } from '../../shared/ipc/schemas/cron';
import { createLogger } from '../services/infra/logger';

type Result = 'shown' | 'generation_failed' | 'not_shown' | 'aborted';
type Entry = {
  request: ScheduleDraftRequest;
  finish: (result: Result) => void;
  confirming: boolean;
};

const requests = new Map<string, Entry>();
const logger = createLogger('ScheduleDraftRequests');

export function registerScheduleDraftRequest(sessionId: string, description: string, signal: AbortSignal) {
  clearScheduleDraftRequest(sessionId);
  const request: ScheduleDraftRequest = { sessionId, requestId: randomUUID(), description, state: 'requested' };
  let resolve!: (result: Result) => void;
  const result = new Promise<Result>((finish) => { resolve = finish; });
  const entry: Entry = {
    request,
    confirming: false,
    finish(outcome) {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (outcome !== 'shown' && requests.get(sessionId) === entry) requests.delete(sessionId);
      resolve(outcome);
    },
  };
  const abort = () => entry.finish('aborted');
  const timeout = setTimeout(() => entry.finish('not_shown'), SCHEDULE_DRAFT_ACK_TIMEOUT_MS);
  requests.set(sessionId, entry);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  logger.info('Awaiting scheduled-task card acknowledgement', { sessionId, requestId: request.requestId });
  return { request, result, cancel: abort };
}

export function getScheduleDraftRequest(sessionId: string): ScheduleDraftRequest | null {
  return requests.get(sessionId)?.request ?? null;
}

export function clearScheduleDraftRequest(sessionId: string): void {
  requests.get(sessionId)?.finish('not_shown');
}

export function acknowledgeScheduleDraft(ack: ScheduleDraftAck): boolean {
  const entry = requests.get(ack.sessionId);
  if (entry?.request.requestId !== ack.requestId) return false;
  const request = entry.request;
  switch (ack.status) {
    case 'prepared':
      if (request.state !== 'requested') return false;
      entry.request = { ...request, state: 'prepared', draft: ack.draft };
      return true;
    case 'shown':
      if (request.state === 'requested') return false;
      if (request.state === 'prepared') {
        entry.request = { ...request, state: 'shown' };
        logger.info('Scheduled-task card acknowledged', { sessionId: ack.sessionId, requestId: ack.requestId });
        entry.finish('shown');
      }
      return true;
    case 'generation_failed':
      if (request.state !== 'requested') return false;
      entry.finish('generation_failed');
      return true;
    case 'discarded':
      if (entry.confirming) return false;
      entry.finish('not_shown');
      return true;
  }
}

export async function confirmScheduleDraftRequest<T>(
  sessionId: string,
  requestId: string,
  createJob: () => Promise<T>,
): Promise<T | null> {
  const entry = requests.get(sessionId);
  if (entry?.request.requestId !== requestId || entry.request.state === 'requested' || entry.confirming) return null;
  entry.confirming = true;
  // An explicit confirmation also proves the card rendered if it raced the shown ACK.
  acknowledgeScheduleDraft({ sessionId, requestId, status: 'shown' });
  try {
    const job = await createJob();
    if (requests.get(sessionId) === entry) requests.delete(sessionId);
    return job;
  } finally {
    entry.confirming = false;
  }
}
