// ============================================================================
// useSessionAgentRows - 「本会话的代理」统一行模型 hook（N-L6-AGENTVIEW）
// ----------------------------------------------------------------------------
// 一根脊柱：useSessionMembers（Team 成员/预选）+ useAgentTreeSnapshot（agentTree
// 快照，含 ownershipConflicts）+ useBackgroundTaskStore（delegate_task 后台任务）。
// 成员条折叠 chip 与右侧「本会话的代理」面板共用这一份，不另起第二份状态。
// ============================================================================

import { useMemo } from 'react';
import type { AgentTreeNode, AgentTreeOwnershipConflict } from '@shared/contract/agentTree';
import { TASK_PANEL_DISMISSED_KEY, type Task } from '@shared/contract/backgroundTask';
import type { PermissionRequest } from '@shared/contract/permission';
import { useAgentTreeSnapshot } from './useAgentTreeSnapshot';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useAppStore } from '../stores/appStore';
import { useSessionMembers } from '../components/features/expert/SessionMemberBar';
import { languages } from '../i18n';
import { backgroundTaskLabels } from '../utils/agentRoleLabel';
import { applyMemberHolds, buildAgentRows, type AgentRow } from '../utils/agentRows';

/** parallelCoordinator/agentWorktree 不带会话归属，没锚点（成员/本会话任务）的节点不列，防跨会话泄漏。 */
const UNANCHORED_SOURCES = new Set(['parallelCoordinator', 'agentWorktree']);

function isSessionNode(
  node: AgentTreeNode,
  anchors: ReadonlySet<string>,
): boolean {
  if (anchors.has(node.id)) return true;
  return node.sources.some((source) => !UNANCHORED_SOURCES.has(source));
}

const REPLACEABLE_FAILED_STATUSES = new Set<string>(['failed', 'expired', 'orphaned']);

function metaString(task: Task, key: string): string {
  const value = task.metadata?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function finishedAt(task: Task): number {
  return task.completedAt ?? task.updatedAt;
}

/** 终态失败任务被同会话里「之后」成功的任务取代：显式 retryOf → 同 laneKey → 同 shortName。 */
function findReplacedFailedTasks(sessionTasks: Task[]): Task[] {
  const completed = sessionTasks.filter((task) => task.status === 'completed');
  if (completed.length === 0) return [];
  return sessionTasks.filter((failed) => {
    if (!REPLACEABLE_FAILED_STATUSES.has(failed.status)) return false;
    const laneKey = metaString(failed, 'laneKey');
    const shortName = metaString(failed, 'shortName');
    return completed.some((done) => {
      const retryOf = done.metadata?.retryOf as { taskId?: unknown } | undefined;
      if (retryOf?.taskId === failed.id) return true;
      if (finishedAt(done) <= finishedAt(failed)) return false;
      if (laneKey && metaString(done, 'laneKey') === laneKey) return true;
      return Boolean(shortName) && metaString(done, 'shortName') === shortName;
    });
  });
}

export interface SessionAgentRows {
  rows: AgentRow[];
  conflicts: AgentTreeOwnershipConflict[];
}

/** 主会话 id：未路由为 default，路由后为当前选中的 agent。 */
function mainConversationAgentIds(activeAgentId: string | null): Set<string> {
  const ids = new Set<string>(['default']);
  if (activeAgentId) ids.add(activeAgentId);
  return ids;
}

function approvalIdsForSession(
  sessionId: string | null,
  pending: PermissionRequest | null,
  pendingSessionId: string | null,
  queued: Record<string, PermissionRequest[] | undefined> | undefined,
  mainAgentIds: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  const add = (request: PermissionRequest | null | undefined) => {
    if (!request || request.resolved) return;
    if (request.agentId && !mainAgentIds.has(request.agentId)) ids.add(request.agentId);
    if (request.runId) ids.add(request.runId);
  };
  if (sessionId && pendingSessionId === sessionId) add(pending);
  if (sessionId) {
    for (const request of queued?.[sessionId] ?? []) add(request);
  }
  return ids;
}

export function useSessionAgentRows(sessionId: string | null): SessionAgentRows {
  const language = useAppStore((state) => state.language);
  const members = useSessionMembers(sessionId);
  const { snapshot } = useAgentTreeSnapshot(sessionId);
  const allTasks = useBackgroundTaskStore((state) => state.tasks);
  const pendingPermissionRequest = useAppStore((state) => state.pendingPermissionRequest);
  const pendingPermissionSessionId = useAppStore((state) => state.pendingPermissionSessionId);
  const queuedPermissionRequests = useAppStore((state) => state.queuedPermissionRequests);
  const activeAgentId = useAppStore((state) => state.activeAgentId);

  return useMemo(() => {
    const sessionTasks = sessionId ? allTasks.filter((task) => task.sessionId === sessionId) : [];
    const replaced = findReplacedFailedTasks(sessionTasks);
    const replacedIds = new Set<string>(replaced.flatMap((task) => {
      const ids = [task.id];
      if (task.runId) ids.push(task.runId);
      const childRunId = task.metadata?.childRunId;
      if (typeof childRunId === 'string') ids.push(childRunId);
      return ids;
    }));
    const tasks = sessionTasks.filter((task) => task.metadata?.[TASK_PANEL_DISMISSED_KEY] !== true
      && !replaced.includes(task));
    const anchors = new Set<string>([
      ...members.map((member) => member.key),
      ...tasks.flatMap((task) => {
        const ids = [task.id];
        if (task.runId) ids.push(task.runId);
        const childRunId = task.metadata?.childRunId;
        if (typeof childRunId === 'string') ids.push(childRunId);
        return ids;
      }),
    ]);
    const nodes = (snapshot?.nodes ?? []).filter((node) => isSessionNode(node, anchors));
    const builtRows = buildAgentRows({
      members,
      nodes,
      tasks,
      taskLabels: backgroundTaskLabels(sessionTasks, languages[language] ?? languages.zh),
    }).filter((row) => replacedIds.size === 0 || ![
      row.key,
      row.node?.id,
      row.task?.id,
      row.task?.runId,
      row.task?.metadata?.childRunId,
    ].some((id) => typeof id === 'string' && replacedIds.has(id)));
    const rows = applyMemberHolds(builtRows, approvalIdsForSession(
      sessionId,
      pendingPermissionRequest,
      pendingPermissionSessionId,
      queuedPermissionRequests,
      mainConversationAgentIds(activeAgentId),
    ));
    return { rows, conflicts: snapshot?.summary.ownershipConflicts ?? [] };
  }, [
    members,
    language,
    snapshot,
    allTasks,
    sessionId,
    pendingPermissionRequest,
    pendingPermissionSessionId,
    queuedPermissionRequests,
    activeAgentId,
  ]);
}
