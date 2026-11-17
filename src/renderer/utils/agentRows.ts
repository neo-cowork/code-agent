import { reconcileAgentNodeLifecycle } from './agentNodeLifecycle';
import { agentNodeLabel, agentRoleLabel, backgroundTaskLabel } from './agentRoleLabel';
import { agentFailureCopy, backgroundTaskFailureCopy } from './agentFailureCopy';
import { languages, type Translations } from '../i18n';
import { resolveAgentNodeOutcomeKey, type OutcomeKey } from '../i18n/outcomeWords';
import { agentFailureHostPhrases } from '../i18n/agentFailureHostPhrases';
import { useAppStore } from '../stores/appStore';
import {
  AgentFailureCode,
  agentFailureCodeFromCancellationReason,
  inferAgentFailureCode,
  isAgentFailureCode,
} from '@shared/contract/agentFailure';
// ============================================================================
// agentRows - 「本会话的代理」统一行模型（N-L6-AGENTVIEW）
// ----------------------------------------------------------------------------
// 一根脊柱的三个既有来源在这里并成一张行表：
//   1) Team 成员（useSessionMembers 的 MemberPill，含 standby 预选）
//   2) agentTree 快照节点（spawn/parallel/后台代理）
//   3) delegate_task 后台任务（backgroundTaskStore 的 Task）
// 节点结局由 resolveAgentNodeOutcomeKey 统一；去重规则只有 buildAgentRows 一处。
// 枚举值绝不直接铺给用户；状态词从共享 outcomeWords 投影。
// ============================================================================

import type { AgentTreeNode } from '@shared/contract/agentTree';
import type { Task, TaskStatus } from '@shared/contract/backgroundTask';

/** 用户可见四态 + 待命（预选名单）。 */
export type AgentRowStatus = 'working' | 'done' | 'failed' | 'cancelled' | 'waiting' | 'standby';

type AgentRowKind = 'expert' | 'agent' | 'task';

/** Team 成员入参的最小结构（MemberPill 天然满足；这里结构化解耦，避免 utils → 组件反向依赖）。 */
export interface MemberRowSource {
  key: string;
  roleId: string;
  name: string;
  profession?: string;
  /** Render-time localized copies (display only). */
  displayName?: string;
  displayProfession?: string;
  icon?: string;
  status: 'standby' | 'running' | 'completed' | 'failed' | 'cancelled';
  isLead: boolean;
  standbyKey?: string;
  /** Swarm 账本记录的改动文件；只读 explore 为 []。 */
  filesChanged?: readonly string[];
  /** 最近可见进展的活锚点（contextSnapshot.lastUpdated，只从活源取，不回落 startTime）；无进展提示（agentRowStall）用它算空转。 */
  lastActivityAt?: number;
  error?: string | null;
  failureCategory?: string | null;
  agent?: { error?: string | null };
  record?: { error?: string | null; failureCategory?: string | null };
}

export interface AgentRow {
  key: string;
  kind: AgentRowKind;
  roleId?: string;
  name: string;
  profession?: string;
  /** Render-time localized name/profession; render with `displayName ?? name`. Never send or store these. */
  displayName?: string;
  displayProfession?: string;
  icon?: string;
  isLead: boolean;
  status: AgentRowStatus;
  /**
   * 等你授权。工具步人话不进这一行（N-ASKUSER-ONE-SIGNAL）：
   * 面板只报状态，细节在点进成员视图之后。
   */
  hold?: 'approval';
  failureReason?: string;
  stoppable: boolean;
  tokens?: number;
  /** Swarm 账本记录的改动文件；只读 explore 为 []。 */
  filesChanged?: readonly string[];
  /** 原始引用：成员视图 / 行级停 / 头像用。 */
  member?: MemberRowSource;
  node?: AgentTreeNode;
  /** Resolved display lifecycle; node remains the unmodified host snapshot. */
  outcomeKey?: OutcomeKey;
  task?: Task;
}

/** Background tasks and member-only ledgers retain their own lifecycle contract. */
const TASK_ROW_STATUS_TABLE: Record<TaskStatus, AgentRowStatus> = {
  queued: 'working',
  running: 'working',
  paused: 'working',
  waiting_input: 'waiting',
  stalled: 'waiting',
  completed: 'done',
  cancelled: 'cancelled',
  failed: 'failed',
  expired: 'failed',
  orphaned: 'failed',
};

function agentRowStatus(status: TaskStatus): AgentRowStatus {
  return TASK_ROW_STATUS_TABLE[status];
}

function nodeRowStatus(outcome: OutcomeKey): AgentRowStatus {
  if (outcome === 'working') return 'working';
  if (outcome === 'waiting-input') return 'waiting';
  if (outcome === 'completed') return 'done';
  return outcome === 'cancelled-by-user' ? 'cancelled' : 'failed';
}

function memberRowStatus(status: MemberRowSource['status']): AgentRowStatus {
  if (status === 'standby') return 'standby';
  return agentRowStatus(status);
}

const PERSISTED_FAILURE_CATEGORY_CODES: Readonly<Record<string, AgentFailureCode>> = {
  worktree_create_failed: AgentFailureCode.WorktreeCreateFailed,
  timeout: AgentFailureCode.Timeout,
  permission: AgentFailureCode.PermissionDenied,
  cancelled: AgentFailureCode.CancelledByUser,
  interrupted_by_restart: AgentFailureCode.ParentGone,
  rate_limit: AgentFailureCode.ModelError,
  network: AgentFailureCode.ModelError,
  parse_error: AgentFailureCode.ModelError,
  unknown: AgentFailureCode.Unknown,
};

function inferPersistedMemberFailureCode(rawError: string, rawCategory: string): AgentFailureCode | undefined {
  if (!rawError && !rawCategory) return undefined;
  if (isAgentFailureCode(rawCategory)) return rawCategory;
  if (rawCategory === 'interrupted_by_restart') return AgentFailureCode.ParentGone;
  if (rawError && Object.hasOwn(agentFailureHostPhrases, rawError)) {
    return agentFailureHostPhrases[rawError];
  }
  const fromCancellation = agentFailureCodeFromCancellationReason(rawError);
  if (fromCancellation) return fromCancellation;
  const categoryCode = PERSISTED_FAILURE_CATEGORY_CODES[rawCategory];
  if (!rawError) return categoryCode ?? AgentFailureCode.Unknown;
  return inferAgentFailureCode({
    error: rawError,
    defaultCode: categoryCode ?? AgentFailureCode.Unknown,
  });
}

function memberFailureReason(member: MemberRowSource, t: Translations): string | undefined {
  if (member.status !== 'failed' && member.status !== 'cancelled') return undefined;
  const rawError = (member.error ?? member.record?.error ?? member.agent?.error ?? '').trim();
  const rawCategory = (member.failureCategory ?? member.record?.failureCategory ?? '').trim();
  const code = inferPersistedMemberFailureCode(rawError, rawCategory);
  return code ? agentFailureCopy(code, t) ?? undefined : undefined;
}

/** delegate_task 后台任务与 agentTree 节点的关联键：id / runId / metadata.childRunId 任一相等即同一个代理。 */
function taskLinkedNodeId(task: Task, nodeIds: ReadonlySet<string>): string | undefined {
  if (nodeIds.has(task.id)) return task.id;
  if (task.runId && nodeIds.has(task.runId)) return task.runId;
  const childRunId = task.metadata?.childRunId;
  if (typeof childRunId === 'string' && nodeIds.has(childRunId)) return childRunId;
  return undefined;
}

export function buildAgentRows(input: {
  members: MemberRowSource[];
  nodes: AgentTreeNode[];
  tasks: Task[];
}): AgentRow[] {
  const { members, nodes, tasks } = input;
  const t = languages[useAppStore.getState().language] ?? languages.zh;
  const rows: AgentRow[] = [];
  const memberById = new Map(members.map((member) => [member.key, member]));

  for (const member of members) {
    const name = member.status !== 'standby' && member.name === member.roleId
      ? agentRoleLabel(member.roleId, t.agentRoleLabels) : member.name;
    rows.push({
      key: member.key,
      kind: 'expert',
      roleId: member.roleId,
      name,
      profession: member.profession,
      displayName: member.displayName !== undefined && member.displayName !== member.name ? member.displayName : undefined,
      displayProfession: member.displayProfession !== member.profession ? member.displayProfession : undefined,
      icon: member.icon,
      isLead: member.isLead,
      status: memberRowStatus(member.status),
      failureReason: memberFailureReason(member, t),
      stoppable: member.status === 'running',
      filesChanged: member.filesChanged,
      member,
    });
  }

  const nodeIds = new Set<string>();
  for (const candidate of nodes) {
    const member = memberById.get(candidate.id);
    const node = reconcileAgentNodeLifecycle(candidate, member);
    const outcome = resolveAgentNodeOutcomeKey(node.status, node.failureCode);
    // Team 成员同时出现在 spawnGuard/parallelCoordinator 里：专家行已经代表他，不重复列；
    // 但节点上的最近工具步/预算是真数据，并回专家行
    if (member) {
      const row = rows.find((candidate) => candidate.key === node.id);
      if (row) {
        row.node = candidate;
        row.outcomeKey = outcome;
        if (node.background && t === languages.en) {
          row.name = agentNodeLabel(node, t.agentRoleLabels);
          row.displayName = undefined;
        }
        // Explicit lifecycle wins; weak unknown contexts retain the member terminal above.
        row.status = nodeRowStatus(outcome);
        row.stoppable = row.status === 'working';
        if (typeof node.budgetSummary.tokensUsed === 'number') row.tokens = node.budgetSummary.tokensUsed;
        if (row.status !== 'failed' && row.status !== 'cancelled') {
          row.failureReason = undefined;
        } else {
          const liveFailureReason = node.failureCode || node.failureReason
            ? agentFailureCopy(node.failureCode, t, node.failureReason) ?? undefined
            : undefined;
          row.failureReason = liveFailureReason
            ?? row.failureReason
            ?? (agentFailureCopy(node.failureCode, t, node.failureReason) ?? undefined);
        }
      }
      continue;
    }
    nodeIds.add(node.id);
    const status = nodeRowStatus(outcome);
    rows.push({
      key: node.id,
      kind: 'agent',
      roleId: node.role,
      name: agentNodeLabel(node, t.agentRoleLabels),
      isLead: false,
      status,
      failureReason: agentFailureCopy(node.failureCode, t, node.failureReason) ?? undefined,
      stoppable: status === 'working',
      tokens: node.budgetSummary.tokensUsed,
      node: candidate,
      outcomeKey: outcome,
    });
  }

  for (const task of tasks) {
    const status = agentRowStatus(task.status);
    const linkedNodeId = taskLinkedNodeId(task, nodeIds);
    if (linkedNodeId) {
      // 同一个代理在 agentTree 与 Task 两边都有：只留节点行，把 Task 挂上去供成员视图取产出
      const row = rows.find((candidate) => candidate.key === linkedNodeId);
      if (row) row.task = task;
      continue;
    }
    rows.push({
      key: task.id,
      kind: 'task',
      name: backgroundTaskLabel(task, t),
      isLead: false,
      status,
      failureReason: backgroundTaskFailureCopy(task, t) ?? undefined,
      stoppable: status === 'working',
      task,
    });
  }

  return rows;
}

/** 审批请求点名的代理，行上改报「需要授权」。点不到具体人就不猜。 */
export function applyMemberHolds(
  rows: AgentRow[],
  approvalIds: ReadonlySet<string>,
): AgentRow[] {
  if (approvalIds.size === 0) return rows;
  return rows.map((row) => {
    const ids = [row.key, row.node?.id, row.task?.id, row.task?.runId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    return ids.some((id) => approvalIds.has(id)) ? { ...row, hold: 'approval' } : row;
  });
}
