// ============================================================================
// sidebarSessionTiers —— 侧栏历史会话三分区（ADR-053 词表落地，批P 第三波）。
// 判据单一真源（禁止 UI 层各自猜）：
//   group.projectId 为空                → 'quick'（快速对话，散会话）
//   project.spacePromotedAt 非空        → 'space'（协作空间，项目的升级形态）
//   其余（有 projectId、未升级）        → 'project'（独立空间）
// meta 尚未拉回的组先按 'project' 落位，meta 到达后重算即可——与分组名/摘要同款异步语义。
// ============================================================================

import { SESSION_PROJECT_PINNED_METADATA_KEY, UNSORTED_PROJECT_ID } from '@shared/contract/project';
import type { SessionWithMeta } from '../stores/sessionStore';
import type { SidebarProjectMeta } from './sidebarProjectSummary';
import { getSidebarGroupKeyForSession, UNCATEGORIZED_WORKSPACE_KEY, type WorkspaceGroup } from './workspaceGrouping';

export type SidebarSessionTier = 'space' | 'project' | 'quick';

/** 分区顺序固定：协作空间 → 独立空间 → 快速对话（ADR-053）。 */
export const SIDEBAR_SESSION_TIER_ORDER: readonly SidebarSessionTier[] = ['space', 'project', 'quick'];

export interface SidebarSessionTierSection {
  tier: SidebarSessionTier;
  groups: WorkspaceGroup[];
  /** 分区内会话总数（过滤态下即命中数），节头计数用。 */
  sessionCount: number;
}

export function resolveSidebarGroupTier(
  group: Pick<WorkspaceGroup, 'projectId'>,
  projectMetaById: Record<string, SidebarProjectMeta>,
): SidebarSessionTier {
  const projectId = group.projectId?.trim();
  if (!projectId) {
    return 'quick';
  }
  return projectMetaById[projectId]?.spacePromotedAt != null ? 'space' : 'project';
}

function latestUpdatedAt(sessions: SessionWithMeta[]): number {
  return sessions.reduce((max, session) => Math.max(max, session.updatedAt || 0), 0);
}

/**
 * 没钉住、住在 Neo 任务文件夹里的会话，分组时进了快速对话（workspaceGrouping 决策 B）。分组那一刻
 * 判不出项目是不是协作空间：用户把这种任务文件夹项目升级成空间后，空间目录一到（spacePromotedAt），
 * 就把它的会话放回空间组（已归档的空间连同会话一起不显示，同 hideArchivedCollaborationSpaces）。
 * 空间自己的目录是任务文件夹时，合成空组的键也落到了快速对话键上，这里改回项目键。
 */
function returnSpaceChats(
  groups: WorkspaceGroup[],
  projectMetaById: Record<string, SidebarProjectMeta>,
): WorkspaceGroup[] {
  // 按「钉在该项目上」取键，和分组的项目键同一来源。
  const spaceKey = (projectId: string) =>
    getSidebarGroupKeyForSession({ projectId, metadata: { [SESSION_PROJECT_PINNED_METADATA_KEY]: true } });
  const spaceIdOf = (projectId?: string | null): string | undefined => {
    const id = projectId?.trim();
    return id && id !== UNSORTED_PROJECT_ID && projectMetaById[id]?.spacePromotedAt != null ? id : undefined;
  };
  const moved = new Map<string, SessionWithMeta[]>();
  let changed = false;
  const result: WorkspaceGroup[] = [];
  for (const group of groups) {
    const groupSpaceId = spaceIdOf(group.projectId);
    if (group.isUncategorized) {
      const kept: SessionWithMeta[] = [];
      for (const session of group.sessions) {
        const spaceId = spaceIdOf(session.projectId);
        if (!spaceId) {
          kept.push(session);
        } else {
          const list = moved.get(spaceId);
          if (list) list.push(session);
          else moved.set(spaceId, [session]);
        }
      }
      if (kept.length === group.sessions.length) {
        result.push(group);
      } else {
        changed = true;
        if (kept.length > 0) result.push({ ...group, sessions: kept, latestActivityAt: latestUpdatedAt(kept) });
      }
    } else if (group.key === UNCATEGORIZED_WORKSPACE_KEY && groupSpaceId) {
      changed = true;
      result.push({ ...group, key: spaceKey(groupSpaceId) });
    } else {
      result.push(group);
    }
  }
  if (!changed) return groups;
  for (const [projectId, sessions] of moved) {
    if (projectMetaById[projectId]?.status === 'archived') continue;
    const key = spaceKey(projectId);
    const latestActivityAt = latestUpdatedAt(sessions);
    const index = result.findIndex((group) => !group.isUncategorized && group.key === key);
    if (index >= 0) {
      const existing = result[index];
      // 按更新时间插进已有顺序（不重排原有会话），组内仍是新的在前。
      const merged = [...existing.sessions];
      for (const session of sessions) {
        const at = merged.findIndex((item) => (item.updatedAt || 0) < (session.updatedAt || 0));
        merged.splice(at < 0 ? merged.length : at, 0, session);
      }
      result[index] = {
        ...existing,
        sessions: merged,
        latestActivityAt: Math.max(existing.latestActivityAt, latestActivityAt),
      };
    } else {
      result.push({
        key,
        name: projectMetaById[projectId]?.name ?? '',
        path: sessions[0]?.workingDirectory?.trim() || undefined,
        paths: [],
        projectId,
        isUncategorized: false,
        sessions,
        latestActivityAt,
      });
    }
  }
  const categorized = result
    .filter((group) => !group.isUncategorized)
    .sort((a, b) => b.latestActivityAt - a.latestActivityAt);
  return [...categorized, ...result.filter((group) => group.isUncategorized)];
}

/**
 * 分组归位到三分区：只重排组的分桶，**组间相对顺序与组内会话排序一律不动**
 * （沿用 groupByWorkspace 的活动度排序；过滤态下「命中即显」的过滤结果同样按 tier 归位）。
 * 例外只有 returnSpaceChats：任务文件夹项目被升级成空间时，把它的会话从快速对话放回空间组。
 * 空分区整节省略（含节头）——返回数组里根本没有它。
 */
export function buildSidebarSessionTierSections(
  groups: WorkspaceGroup[],
  projectMetaById: Record<string, SidebarProjectMeta>,
): SidebarSessionTierSection[] {
  const byTier = new Map<SidebarSessionTier, WorkspaceGroup[]>();
  for (const group of returnSpaceChats(groups, projectMetaById)) {
    const tier = resolveSidebarGroupTier(group, projectMetaById);
    const bucket = byTier.get(tier);
    if (bucket) {
      bucket.push(group);
    } else {
      byTier.set(tier, [group]);
    }
  }
  return SIDEBAR_SESSION_TIER_ORDER.flatMap((tier) => {
    const tierGroups = byTier.get(tier);
    if (!tierGroups || tierGroups.length === 0) return [];
    // 快速对话层：无组头的未分类会话排最前，否则会视觉并入上方有头的文件夹组（收起该文件夹时像收起失效）。
    if (tier === 'quick') {
      tierGroups.sort((a, b) => Number(b.isUncategorized) - Number(a.isUncategorized));
    }
    return [
      {
        tier,
        groups: tierGroups,
        sessionCount: tierGroups.reduce((total, group) => total + group.sessions.length, 0),
      },
    ];
  });
}
