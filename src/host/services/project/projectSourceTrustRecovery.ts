// ============================================================================
// ProjectSourceTrustRecovery - 会话内「确认并重发」的一次性信任补拍
// ============================================================================
// 旧库 trusted Source 的 identity 快照可能整体缺失（identity_dev/ino/birthtime_ns
// 全 NULL）：getWorkspaceScope fail-closed 拒绝，用户在聊天里发送即 422
// PROJECT_SOURCE_TRUST（N-FIX-SIGNED-OUT-SEND-500-RAW-HTML-REDESIGN）。这里实现
// 用户显式确认后的恢复：只重拍「快照缺失且目录还在、身份没真变」的 Source——
//   setFolderTrust（folder_trust 表落当前身份）→ 既有 updateProject 路径原样重跑
//   （buildSource 现读 stat 重拍快照；evaluateFolderTrust 门与 TOCTOU 检查都在
//   既有路径里）。目录消失 / 身份真的变了 / 信任被吊销一律拒绝，绝不静默补信任。
// 客户端只给 sessionId；Source 集合从服务端台账现读，不接受任何路径输入。
// ============================================================================

import type { ProjectSource } from '../../../shared/contract/project';
import {
  workspaceIdentityMatches,
  workspacePathIdentity,
} from '../../runtime/workspaceScope';
import { setFolderTrust } from '../../security/folderTrustService';
import type { ProjectService } from './projectService';

export type ProjectTrustConfirmFailureReason =
  | 'project_not_found'
  | 'nothing_to_confirm'
  | 'source_missing'
  | 'identity_changed'
  | 'not_trusted'
  | 'folder_trust_record_failed'
  | 'update_rejected'
  | 'verification_failed';

export class ProjectTrustConfirmError extends Error {
  constructor(readonly reason: ProjectTrustConfirmFailureReason) {
    super(`Project trust confirmation rejected: ${reason}`);
    this.name = 'ProjectTrustConfirmError';
  }
}

/** 与 ProjectService.getWorkspaceScope 同一份判据：缺快照的 trusted Source 是可恢复对象。 */
function missingSnapshot(source: ProjectSource): boolean {
  return source.identityDev == null
    && source.identityIno == null
    && source.identityBirthtimeNs == null;
}

function trustFailureOf(source: ProjectSource): 'source_missing' | 'identity_changed' | 'not_trusted' | undefined {
  const identity = workspacePathIdentity(source.canonicalPath);
  if (identity.dev === null || identity.ino === null) return 'source_missing';
  if (!workspaceIdentityMatches(source, identity)) return 'identity_changed';
  if (source.trustState !== 'trusted') return 'not_trusted';
  return undefined;
}

/** 既有 updateProject 路径的守门文案 → 稳定拒绝原因（Folder Trust 门 / revision 竞态）。 */
function mapUpdateProjectError(error: unknown): ProjectTrustConfirmFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('Folder Trust is required for Source')) return 'identity_changed';
  if (message.startsWith('Project Sources changed')) return 'update_rejected';
  return 'verification_failed';
}

export interface ConfirmSessionProjectSourcesInput {
  projectId: string;
  projects: Pick<ProjectService, 'getProjectDetail' | 'listSources' | 'updateProject' | 'getWorkspaceScope'>;
  now?: number;
}

export async function confirmSessionProjectSources(
  input: ConfirmSessionProjectSourcesInput,
): Promise<{ confirmed: true; sources: number }> {
  const { projectId, projects } = input;
  const now = input.now ?? Date.now();
  const detail = projects.getProjectDetail(projectId);
  if (!detail) throw new ProjectTrustConfirmError('project_not_found');

  const sources = projects.listSources(projectId);
  const failing = sources.filter((source) => trustFailureOf(source) !== undefined);
  if (failing.length === 0) {
    // 幂等：再次点击确认（或并发恢复）时没有可恢复对象，不算失败。
    return { confirmed: true, sources: 0 };
  }
  // 只恢复「快照整体缺失」的 trusted Source：快照存在但不匹配 = 目录身份真的变了，
  // 必须走正常的 Folder Trust 流程；目录不在盘上 / 信任被吊销同理拒绝。
  for (const source of failing) {
    const failure = trustFailureOf(source);
    if (failure === 'source_missing' || failure === 'not_trusted') {
      throw new ProjectTrustConfirmError(failure);
    }
    if (!missingSnapshot(source)) {
      throw new ProjectTrustConfirmError('identity_changed');
    }
  }

  const expectedIdentity = new Map(
    failing.map((source) => [source.id, workspacePathIdentity(source.canonicalPath)]),
  );
  for (const source of failing) {
    await setFolderTrust(source.canonicalPath, 'trusted', 'user').catch((_error) => {
      throw new ProjectTrustConfirmError('folder_trust_record_failed');
    });
  }
  try {
    const updated = await projects.updateProject({
      projectId,
      revision: detail.project.sourceRevision ?? 0,
      name: detail.project.name,
      description: detail.project.description ?? null,
      sources: sources.map((source) => ({
        id: source.id,
        path: source.path,
        role: source.role,
        access: source.access,
      })),
    }, now);
    if (!updated) throw new ProjectTrustConfirmError('project_not_found');
  } catch (error) {
    if (error instanceof ProjectTrustConfirmError) throw error;
    throw new ProjectTrustConfirmError(mapUpdateProjectError(error));
  }

  // 复核：快照确实重拍（非 NULL）且与确认时读到的身份一致——中途换了目录会被
  // updateProject 的 Folder Trust 门挡下，这里再兜一道断言。
  const refreshed = projects.listSources(projectId);
  for (const source of failing) {
    const row = refreshed.find((item) => item.id === source.id);
    const expected = expectedIdentity.get(source.id);
    if (!row || !expected
      || row.identityIno == null || row.identityBirthtimeNs == null
      || row.identityIno !== expected.ino || row.identityBirthtimeNs !== expected.birthtimeNs) {
      throw new ProjectTrustConfirmError('verification_failed');
    }
  }
  projects.getWorkspaceScope(projectId);
  return { confirmed: true, sources: failing.length };
}
