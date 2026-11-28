// ============================================================================
// workspaceGrouping - Group sessions by project first, workspace as fallback.
// ============================================================================
// Sessions with a persisted projectId are bucketed by that Project. Sessions
// without project metadata fall back to full workingDirectory path so same-name
// folders under different parents stay separate. A separate uncategorized
// bucket collects sessions that have no project/workspace context, plus chats
// living in a Neo-made task folder that are not pinned to a project (owner
// decision B: such a folder is the chat's file home, not a sidebar group).

import { SESSION_PROJECT_PINNED_METADATA_KEY, UNSORTED_PROJECT_ID } from '@shared/contract/project';
import type { SessionWithMeta } from '../stores/sessionStore';

// Key used for sessions with no workingDirectory; reserved so it can't
// collide with an actual workspace path.
export const UNCATEGORIZED_WORKSPACE_KEY = '__chats__';

export interface WorkspaceGroup {
  /** Stable identifier. Project groups use project:<id>, workspace fallback
   *  groups use the full workspace path, and the fallback bucket uses
   *  UNCATEGORIZED_WORKSPACE_KEY. */
  key: string;
  /** Display name — project groups use their newest listed workspace basename
   *  until Project metadata loads; the fallback bucket uses the caller-supplied
   *  uncategorizedName (i18n, 禁硬编码). */
  name: string;
  /** Primary workspace path, usually the most recently active session's path. */
  path?: string;
  /** Workspace paths listed for the group (hover tip, drawer), newest activity
   *  first. Neo-made task folders are left out. */
  paths: string[];
  /** Project id for this group, when known. */
  projectId?: string;
  /** true iff this is the bucket for sessions with no project/workspace. */
  isUncategorized: boolean;
  /** Sessions in this group, ordered most-recently-updated first. */
  sessions: SessionWithMeta[];
  /** Max updatedAt across sessions; drives group ordering. */
  latestActivityAt: number;
}

interface SidebarGroupKeySource {
  projectId?: string | null;
  workingDirectory?: string | null;
  metadata?: Record<string, unknown> | null;
}

// Same shape as the host's PLANNED_FOLDER_NAME_PATTERN in
// src/host/config/sessionWorkDirectory.ts (任务_MMDD_… / Task_MMDD_…). The
// renderer does not know the default work root, so only the last segment counts.
const TASK_FOLDER_NAME_PATTERN = /^(任务|Task)_\d{4}_/;

function isTaskFolderPath(path: string): boolean {
  const segments = path.split(/[\\/]/).filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  return Boolean(lastSegment && TASK_FOLDER_NAME_PATTERN.test(lastSegment));
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return path;
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || trimmed;
}

interface SessionBucket {
  sessions: SessionWithMeta[];
  projectId?: string;
}

function projectGroupKey(projectId: string): string {
  return `project:${projectId}`;
}

function getSessionProjectId(session: SidebarGroupKeySource): string | undefined {
  const projectId = session.projectId?.trim();
  if (!projectId || projectId === UNSORTED_PROJECT_ID) {
    return undefined;
  }
  return projectId;
}

export function getSidebarGroupKeyForSession(session: SidebarGroupKeySource): string {
  const projectId = getSessionProjectId(session);
  const path = session.workingDirectory?.trim();
  // An explicitly chosen project (e.g. a chat created inside a space) keeps its group even
  // when Neo planned a task folder for the chat.
  if (projectId && session.metadata?.[SESSION_PROJECT_PINNED_METADATA_KEY] === true) {
    return projectGroupKey(projectId);
  }
  if (path && isTaskFolderPath(path)) {
    return UNCATEGORIZED_WORKSPACE_KEY;
  }
  if (projectId) {
    return projectGroupKey(projectId);
  }
  return path || UNCATEGORIZED_WORKSPACE_KEY;
}

/**
 * Pick the landing session in the same sidebar group after removing one or
 * more sessions: ordered by updatedAt descending (matching the sidebar), next
 * older row first, else nearest newer row; undefined when the group empties.
 */
export function findSessionAfterRemoval(
  sessions: SessionWithMeta[],
  currentId: string,
  removedIds: ReadonlySet<string> = new Set([currentId]),
): SessionWithMeta | undefined {
  const current = sessions.find((session) => session.id === currentId);
  if (!current) return undefined;
  const groupKey = getSidebarGroupKeyForSession(current);
  const siblings = sessions
    .filter((session) => getSidebarGroupKeyForSession(session) === groupKey)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const currentIndex = siblings.indexOf(current);
  const survives = (session: SessionWithMeta) => !removedIds.has(session.id);
  return siblings.slice(currentIndex + 1).find(survives)
    ?? siblings.slice(0, currentIndex).reverse().find(survives);
}

function getGroupPaths(sessions: SessionWithMeta[]): string[] {
  const paths: string[] = [];
  for (const session of sessions) {
    const path = session.workingDirectory?.trim();
    if (path && !paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Partition sessions into project/workspace groups.
 *
 * - Project groups are keyed by persisted projectId.
 * - Sessions without project metadata fall back to full workingDirectory path.
 * - Unpinned chats in a Neo-made task folder join the uncategorized bucket.
 * - The uncategorized bucket (if non-empty) is always appended at the end; its
 *   display name comes from the caller (i18n), not hardcoded here.
 * - `projectFallbackName` covers the rare group with no listed path at all, e.g. a
 *   folderless space whose chats live in task folders, until Project metadata loads
 *   (i18n, 禁硬编码 — 复用侧栏「项目」section 标题词条即可)。
 */
export function groupByWorkspace(
  sessions: SessionWithMeta[],
  uncategorizedName: string,
  projectFallbackName: string,
): WorkspaceGroup[] {
  const buckets = new Map<string, SessionBucket>();

  for (const session of sessions) {
    const key = getSidebarGroupKeyForSession(session);
    const projectId = getSessionProjectId(session);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.sessions.push(session);
    } else {
      buckets.set(key, { sessions: [session], projectId });
    }
  }

  const categorized: WorkspaceGroup[] = [];
  let uncategorized: WorkspaceGroup | null = null;

  for (const [key, bucket] of buckets.entries()) {
    const sortedSessions = [...bucket.sessions].sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    );
    const latestActivityAt = sortedSessions.reduce(
      (max, s) => Math.max(max, s.updatedAt || 0),
      0,
    );
    const sessionPaths = getGroupPaths(sortedSessions);
    // A Neo-made task folder is a chat's file home, not where its group lives (each chat in a
    // folderless space gets one), so it neither names the group nor is listed as its path.
    const paths = sessionPaths.filter((path) => !isTaskFolderPath(path));
    const primaryPath = sessionPaths[0];

    if (key === UNCATEGORIZED_WORKSPACE_KEY) {
      uncategorized = {
        key,
        // 这是默认的纯对话归宿（非"没分类好"的失败态），组名由调用方按 i18n 传入。
        name: uncategorizedName,
        isUncategorized: true,
        paths,
        sessions: sortedSessions,
        latestActivityAt,
      };
    } else {
      categorized.push({
        key,
        name: paths[0] ? basenameOf(paths[0]) : projectFallbackName,
        path: primaryPath,
        paths,
        isUncategorized: false,
        projectId: bucket.projectId,
        sessions: sortedSessions,
        latestActivityAt,
      });
    }
  }

  categorized.sort((a, b) => b.latestActivityAt - a.latestActivityAt);

  return uncategorized ? [...categorized, uncategorized] : categorized;
}

/**
 * A workspace is expanded by default. Only an explicit `false` collapses it,
 * so entries not yet recorded in the persisted map still open on first sight.
 */
export function isWorkspaceExpanded(
  expandedMap: Record<string, boolean>,
  key: string,
): boolean {
  return expandedMap[key] !== false;
}
