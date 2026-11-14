import { SessionDelegationRepository } from '../core/repositories/SessionDelegationRepository';
import { createLogger } from '../infra/logger';
import { projectSessionCandidates, resolveCandidateRef } from './delegationCandidates';
import { getDelegationCandidateSecret, getDelegationToolRuntime } from './delegationToolRuntime';

const logger = createLogger('DelegationApprovalTarget');

/** Read-only display lookup. Admission still resolves and checks the target independently. */
export function resolveDelegationApprovalTarget(
  params: Record<string, unknown>,
  originSessionId: string | undefined,
): string | undefined {
  if (params.action === 'create_new') return undefined;
  const unavailable = (cause: string) => {
    logger.warn('Delegation approval target unavailable', { cause });
    return undefined;
  };
  try {
    if (!originSessionId) return unavailable('origin_missing');
    const runtime = getDelegationToolRuntime();
    let targetSessionId: string;
    if (params.action === 'delegate_existing') {
      if (typeof params.candidateSetId !== 'string' || !params.candidateSetId) return unavailable('set_missing');
      const secret = getDelegationCandidateSecret();
      const projection = projectSessionCandidates(runtime.listSessions(), {
        originSessionId, now: runtime.now(), secret,
      });
      const resolved = resolveCandidateRef({
        candidateSetId: params.candidateSetId,
        candidateRef: typeof params.candidateRef === 'string' ? params.candidateRef : undefined,
      }, projection, secret);
      if (!resolved.ok) return unavailable(resolved.code === 'candidate_set_stale' ? 'set_stale' : 'ref_not_found');
      targetSessionId = resolved.sessionId;
    } else {
      const db = runtime.getDb();
      const row = db && typeof params.delegationId === 'string'
        ? new SessionDelegationRepository(db).get(params.delegationId) : null;
      if (row?.originSessionId !== originSessionId) return unavailable('delegation_not_found');
      targetSessionId = row.targetSessionId;
    }
    const target = runtime.getSessionRow(targetSessionId);
    if (!target || target.isDeleted || target.isArchived) return unavailable('session_gone');
    return target.title?.trim() || unavailable('title_missing');
  } catch {
    return unavailable('lookup_failed');
  }
}
