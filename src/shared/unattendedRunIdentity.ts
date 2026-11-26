import type { Session } from './contract/session';
import { ROLE_PROACTIVITY } from './constants';

/** A wake has its own run identity; it is never a synthetic cron job. */
export function resolveUnattendedRunIdentity(session: Pick<Session, 'id' | 'origin' | 'sourceRunId'> | null | undefined):
  { kind: 'role_wake'; runKey: string } | { kind: 'cron'; runKey: string; jobId: string } | null {
  const origin = session?.origin;
  if (!session || (origin?.kind !== 'cron' && origin?.kind !== 'heartbeat')) return null;
  if (origin.name === ROLE_PROACTIVITY.CADENCE_JOB_TAG) {
    return { kind: 'role_wake', runKey: session.sourceRunId || session.id };
  }
  const jobId = origin.id?.trim();
  return jobId ? { kind: 'cron', jobId, runKey: session.sourceRunId || session.id } : null;
}

/** Run-record id for a role wake; the session id is the run key when there is no cron job id. */
export function roleWakeAutomationId(sessionId: string): string {
  return ['role_wake', sessionId].join(':');
}
