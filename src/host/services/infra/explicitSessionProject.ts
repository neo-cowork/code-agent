import type { Session } from '@shared/contract';
import {
  SESSION_PROJECT_PINNED_METADATA_KEY,
  SESSION_PROJECT_UNAVAILABLE,
} from '@shared/contract/project';
import { getProjectService } from '../project/projectService';

/** 显式 projectId 必须指向仍可用的项目。缺失、已删除、已归档都拒绝，不回落到未分类。 */
export function resolveExplicitSessionProject(projectId: string): { id: string } {
  const detail = getProjectService().getProjectDetail(projectId);
  if (!detail || detail.project.status === 'archived') {
    throw new Error(SESSION_PROJECT_UNAVAILABLE);
  }
  return { id: detail.project.id };
}

export function pinSessionProjectMetadata(metadata: Session['metadata'] | undefined): Session['metadata'] {
  return {
    ...(metadata ?? {}),
    [SESSION_PROJECT_PINNED_METADATA_KEY]: true,
  };
}

/**
 * 创建事务写入前决定 projectId。
 * 调用方给了 projectId 就钉住并跳过目录反查；没给则保持原目录归属。
 */
export async function applySessionProjectOnCreate(
  session: Session,
  requestedProjectId: string | undefined,
  now: number,
): Promise<void> {
  const explicitProjectId = requestedProjectId?.trim();
  if (explicitProjectId) {
    const project = resolveExplicitSessionProject(explicitProjectId);
    session.projectId = project.id;
    session.metadata = pinSessionProjectMetadata(session.metadata);
    return;
  }
  const project = await getProjectService().ensureProjectForWorkspace(session.workingDirectory, now);
  session.projectId = project.id;
}
