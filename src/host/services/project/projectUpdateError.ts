import type {
  ProjectSource,
  ProjectSourceTrustFailureKind,
  WorkspaceScope,
} from '../../../shared/contract/project';
import {
  workspaceIdentityMatches,
  workspacePathIdentity,
} from '../../runtime/workspaceScope';

/** 编辑项目对话框可达的主机校验失败；code 随 IPC 信封到渲染层，由 i18n 出文案。 */
export type ProjectUpdateErrorCode =
  | 'PROJECT_UPDATE_RUNNING_TASK'
  | 'PROJECT_UPDATE_DIRTY_SOURCE'
  | 'PROJECT_UPDATE_FOLDER_TRUST'
  | 'PROJECT_UPDATE_DUPLICATE_PATH'
  | 'PROJECT_UPDATE_UNSAFE_PATH'
  | 'PROJECT_UPDATE_PRIMARY_UNWRITABLE'
  | 'PROJECT_UPDATE_REVISION_CONFLICT';

export class ProjectUpdateError extends Error {
  constructor(readonly code: ProjectUpdateErrorCode, message: string) {
    super(message);
    this.name = 'ProjectUpdateError';
  }
}

export function sourceTrustFailureKind(
  source: Pick<ProjectSource, 'trustState' | 'identityDev' | 'identityIno' | 'identityBirthtimeNs'>,
  identity: ReturnType<typeof workspacePathIdentity>,
): ProjectSourceTrustFailureKind | undefined {
  if (identity.dev === null || identity.ino === null) return 'source_missing';
  if (!workspaceIdentityMatches(source, identity)) return 'identity_changed';
  if (source.trustState !== 'trusted') return 'not_trusted';
  return undefined;
}

/**
 * 被移除的 Source 里只有「仍健康」的才能查 git 脏状态；丢失 / 身份变更 / 未授权的无从检查，
 * 跳过而不抛（否则已丢失的旧目录会堵死它自己的移除）。getWorkspaceScope 的 fail-closed 不受影响。
 */
export function healthyRemovedGitScope(
  projectId: string,
  removed: readonly ProjectSource[],
): WorkspaceScope | undefined {
  const roots = removed
    .filter((source) => !sourceTrustFailureKind(source, workspacePathIdentity(source.canonicalPath)))
    .map((source) => Object.freeze({
      sourceId: source.id,
      path: source.canonicalPath,
      role: source.role,
      access: source.access,
      identityDev: source.identityDev,
      identityIno: source.identityIno,
      identityBirthtimeNs: source.identityBirthtimeNs,
    }));
  if (roots.length === 0) return undefined;
  return Object.freeze({ projectId, primaryRoot: roots[0].path, roots: Object.freeze(roots), version: '' });
}
