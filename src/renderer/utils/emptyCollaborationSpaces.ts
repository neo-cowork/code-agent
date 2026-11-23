// 没有可见会话的协作空间仍要出现在侧栏。可见数来自 SQL 全量计数：
// 已有会话但没落在已加载的那一页上时 visibleSessionCount !== 0，这里不合成空组。

import { UNSORTED_PROJECT_ID, type ProjectWithActivity } from '@shared/contract/project';
import type { SidebarProjectMeta } from './sidebarProjectSummary';
import { getSidebarGroupKeyForSession, type WorkspaceGroup } from './workspaceGrouping';

export function mergeEmptyCollaborationSpaces(
  groups: readonly WorkspaceGroup[],
  spaces: readonly ProjectWithActivity[],
  /** 搜索/状态/轨迹筛选生效时，没有会话的空间不可能命中，不并入。 */
  isFiltering = false,
): WorkspaceGroup[] {
  if (isFiltering) return groups as WorkspaceGroup[];
  const occupied = new Set(
    groups
      .map((group) => group.projectId?.trim())
      .filter((projectId): projectId is string => Boolean(projectId)),
  );
  const extras: WorkspaceGroup[] = [];
  for (const space of spaces) {
    const projectId = space.id?.trim();
    if (!projectId || projectId === UNSORTED_PROJECT_ID) continue;
    if (space.visibleSessionCount !== 0) continue;
    if (occupied.has(projectId)) continue;
    const path = space.workspacePath?.trim() || undefined;
    extras.push({
      key: getSidebarGroupKeyForSession({ projectId, workingDirectory: path }),
      name: space.name,
      path,
      paths: path ? [path] : [],
      projectId,
      isUncategorized: false,
      sessions: [],
      latestActivityAt: space.lastActivityAt ?? space.updatedAt ?? 0,
    });
    occupied.add(projectId);
  }
  if (extras.length === 0) return groups as WorkspaceGroup[];

  const categorized = [...groups.filter((group) => !group.isUncategorized), ...extras];
  categorized.sort((left, right) => right.latestActivityAt - left.latestActivityAt);
  return [...categorized, ...groups.filter((group) => group.isUncategorized)];
}

/** 目录行先补上空间名和升级时间，已有详情字段不被目录行盖掉。 */
export function overlaySpaceCatalogMeta(
  current: Record<string, SidebarProjectMeta>,
  spaces: readonly ProjectWithActivity[],
): Record<string, SidebarProjectMeta> {
  let next: Record<string, SidebarProjectMeta> | null = null;
  for (const space of spaces) {
    const id = space.id?.trim();
    if (!id) continue;
    const existing = (next ?? current)[id];
    const seeded: SidebarProjectMeta = {
      ...existing,
      name: existing?.name || space.name,
      status: existing?.status ?? space.status,
      description: existing?.description ?? space.description,
      spacePromotedAt: existing?.spacePromotedAt ?? space.spacePromotedAt ?? null,
      cloudProjectId: existing?.cloudProjectId ?? space.cloudProjectId ?? null,
      updatedAt: existing?.updatedAt ?? space.updatedAt,
    };
    if (!next) next = { ...current };
    next[id] = seeded;
  }
  return next ?? current;
}

export function hideArchivedCollaborationSpaces(
  groups: readonly WorkspaceGroup[],
  metaById: Record<string, SidebarProjectMeta>,
): WorkspaceGroup[] {
  const visible = groups.filter((group) => {
    const projectId = group.projectId?.trim();
    if (!projectId) return true;
    const meta = metaById[projectId];
    return !(meta?.spacePromotedAt != null && meta.status === 'archived');
  });
  return visible.length === groups.length ? (groups as WorkspaceGroup[]) : visible;
}
