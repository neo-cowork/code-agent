import { randomUUID } from 'node:crypto';
import type { Project, ProjectSource } from '../../../shared/contract/project';
import { PROJECT_IDENTITY_CONFIRMATION } from '../../../shared/constants/projectIdentityConfirmation';
import { workspacePathIdentity, workspaceIdentityMatches } from '../../runtime/workspaceScope';
import { resolveBackgroundWorkspaceAuthority } from '../../runtime/workspaceAuthority';
import { evaluateFolderTrust, setFolderTrust } from '../../security/folderTrustService';
import { getDatabase } from '../core/databaseService';
import { getAuthService } from '../auth/authService';
import type { ProjectService } from './projectService';

type Challenge = { project: Project; sources: ProjectSource[]; sourceId: string; fingerprint: string; expiresAt: number };
const pending = new Map<string, Challenge>();
const missingIdentity = (source: ProjectSource): boolean =>
  source.identityDev == null && source.identityIno == null && source.identityBirthtimeNs == null;
const fingerprint = (sources: ProjectSource[]): string => JSON.stringify(sources.map(source => ({
  ...source, current: workspacePathIdentity(source.canonicalPath),
})));

/** Only one missing snapshot, with every other source already verified, is recoverable here. */
export function issueProjectIdentityConfirmation(project: Project, sources: ProjectSource[]): string | undefined {
  const missing = sources.filter(missingIdentity);
  if (missing.length !== 1 || sources.some(source => {
    const current = workspacePathIdentity(source.canonicalPath);
    return source.trustState !== 'trusted' || !current.ino || !current.birthtimeNs
      || !resolveBackgroundWorkspaceAuthority({ workspace: source.canonicalPath })
      || (!missingIdentity(source) && !workspaceIdentityMatches(source, current));
  })) return undefined;
  for (const [id, challenge] of pending) if (challenge.expiresAt <= Date.now()) pending.delete(id);
  for (const id of pending.keys()) {
    if (pending.size < PROJECT_IDENTITY_CONFIRMATION.MAX_PENDING) break;
    pending.delete(id);
  }
  const token = randomUUID();
  pending.set(token, { project, sources, sourceId: missing[0].id, fingerprint: fingerprint(sources),
    expiresAt: Date.now() + PROJECT_IDENTITY_CONFIRMATION.TTL_MS });
  return token;
}

/** A separate explicit-consent action; never changes an already recorded identity. */
export async function confirmProjectIdentity(service: ProjectService, payload: unknown): Promise<{ confirmed: true }> {
  const request = payload as { sessionId?: unknown; token?: unknown; confirmed?: unknown } | null;
  if (request?.confirmed !== true || typeof request.token !== 'string' || typeof request.sessionId !== 'string') {
    throw new Error('PROJECT_IDENTITY_CONFIRMATION_REQUIRED');
  }
  const challenge = pending.get(request.token);
  pending.delete(request.token);
  if (!challenge || challenge.expiresAt <= Date.now()) throw new Error('PROJECT_IDENTITY_CONFIRMATION_EXPIRED');
  const session = getDatabase().getSession(request.sessionId, { userId: getAuthService().getCurrentUser()?.id ?? null });
  const detail = service.getProjectDetail(challenge.project.id);
  const sources = service.listSources(challenge.project.id);
  if (session?.projectId !== challenge.project.id || !detail
    || detail.project.sourceRevision !== challenge.project.sourceRevision
    || fingerprint(sources) !== challenge.fingerprint) throw new Error('PROJECT_IDENTITY_CONFIRMATION_STALE');
  const source = sources.find(item => item.id === challenge.sourceId);
  if (!source || !missingIdentity(source) || source.trustState !== 'trusted') throw new Error('PROJECT_IDENTITY_CONFIRMATION_STALE');
  const expected = workspacePathIdentity(source.canonicalPath);
  if (!expected.ino || !expected.birthtimeNs) throw new Error('PROJECT_IDENTITY_CONFIRMATION_STALE');
  const trust = await evaluateFolderTrust(source.canonicalPath);
  if (trust.identityChanged || trust.contentChanged || trust.state === 'blocked'
    || (trust.state !== 'trusted' && trust.dangerousItems.some(item => item.gated))) {
    throw new Error('PROJECT_IDENTITY_NORMAL_TRUST_REQUIRED');
  }
  if (fingerprint(service.listSources(challenge.project.id)) !== challenge.fingerprint) throw new Error('PROJECT_IDENTITY_CONFIRMATION_STALE');
  await setFolderTrust(source.canonicalPath, 'trusted', 'user', { ino: expected.ino, birthtimeNs: expected.birthtimeNs });
  const updated = await service.updateProject({
    projectId: detail.project.id, revision: detail.project.sourceRevision ?? 0,
    name: detail.project.name, description: detail.project.description,
    sources: sources.map(item => ({ id: item.id, path: item.path, role: item.role, access: item.access })),
  }, Date.now());
  if (!updated) throw new Error('PROJECT_IDENTITY_CONFIRMATION_STALE');
  service.getWorkspaceScope(detail.project.id);
  return { confirmed: true };
}
