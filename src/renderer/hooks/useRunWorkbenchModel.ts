// ============================================================================
// useRunWorkbenchModel - 工作台任务/运行视图模型
// ----------------------------------------------------------------------------
// 跨会话任务卡数据源统一（2026-07-27，与侧栏同口径）：
// - 状态分类唯一走 sessionPresentation.getSessionStatusPresentation 的
//   kind/文案映射，不再自备一套 status→文案翻译；
// - 标题按 sourceThreadId 从 sessionStore.sessions 查 DB 标题
//   （getDisplaySessionTitle 归一，按界面语言显示前缀），查不到才退回「会话 <id 前 8 位>」占位；
// - DB session.status 由主进程 TaskManager 在 run 生命周期边界回写
//   （崩溃由 markCrashedActiveSessions 追认 interrupted/orphaned），
//   重启后概览与侧栏对同一会话的标题/状态分类/集合一致。
// ============================================================================

import { useMemo } from 'react';
import { languages, type Language, type Translations } from '../i18n';
import { backgroundTaskLabels } from '../utils/agentRoleLabel';
import { withAutomationPromptTimeoutHint } from '@shared/i18n/sessionTaskSlot';
import { useAppStore } from '../stores/appStore';
import { useSessionStore, type SessionWithMeta } from '../stores/sessionStore';
import { useTaskStore } from '../stores/taskStore';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useWorkflowStore } from '../stores/workflowStore';
import { useCurrentTurnExecutionProjection } from './useCurrentTurnExecutionProjection';
import { useStatusRailModel } from './useStatusRailModel';
import type {
  RunWorkbenchModel,
  SubagentRunView,
  TaskRecord,
  TaskRecordOutputRef,
} from '../types/runWorkbench';
import type { ScriptRunAgentSnapshot, ScriptRunSnapshot } from '@shared/contract/scriptRun';
import type { SwarmRunAgentRecord } from '@shared/contract/swarmTrace';
import type { Task } from '@shared/contract/backgroundTask';
import { describeTaskBlockedReason } from '@shared/taskReasonLanguage';
import type { TaskBlockedCategory } from '@shared/contract/planning';
import {
  getLongTaskStatusLabel,
  normalizeLongTaskStatus,
  type LongTaskUiStatus,
} from '@shared/contract/productClosure';
import {
  getDisplaySessionTitle,
  getSessionStatusPresentation,
  type SessionStatusKind,
} from '../utils/sessionPresentation';
import {
  buildLoopDecisionViews,
  buildSessionMemoryActivityEvents,
  buildOutputArtifactViews,
  buildRunUiState,
  buildSessionTaskRecord,
  buildSessionToolCapabilityViews,
} from '../utils/runWorkbenchProjection';
import { buildWorkflowTimeline } from '../utils/workflowTimeline';
import { BACKGROUND_TASK_DELETE_INCOMPLETE } from '@shared/constants';
import { backgroundTaskFailureCopy, isShellBackgroundTask } from '../utils/agentFailureCopy';
import { useDurableSwarmRunDetail } from './useDurableSwarmRunDetail';

/**
 * SessionStatusKind（侧栏唯一分类器的 kind）→ TaskRecord 状态。
 * 与侧栏显示保持一致：执行中类（live/background/approval/paused）都计 in_progress，
 * error 计 blocked；done/incomplete/idle 在跨会话卡集合里不出现（入口已过滤），
 * 仅作全函数兜底。
 */
function sessionStatusKindToTaskStatus(kind: SessionStatusKind): TaskRecord['status'] {
  switch (kind) {
    case 'live':
    case 'background':
    case 'approval':
    case 'paused':
      return 'in_progress';
    case 'error':
      return 'blocked';
    case 'done':
      return 'completed';
    case 'incomplete':
    case 'idle':
    default:
      return 'pending';
  }
}

export function buildGlobalTaskRecords(args: {
  language: Language;
  currentSessionId: string | null;
  sessionStates: ReturnType<typeof useTaskStore.getState>['sessionStates'];
  /** sessionStore.sessions（DB 标题 + 持久化状态），按 sourceThreadId 反查 */
  sessions?: ReadonlyArray<Pick<SessionWithMeta, 'id' | 'title' | 'status'>>;
}): TaskRecord[] {
  const t = languages[args.language];
  return Object.entries(args.sessionStates)
    .filter(([sessionId, state]) => (
      sessionId !== args.currentSessionId
      && (state.status === 'running' || state.status === 'queued' || state.status === 'paused' || state.status === 'error')
    ))
    .map(([sessionId, state]) => {
      const session = args.sessions?.find((item) => item.id === sessionId);
      // 与侧栏同一分类器：P1 内存信号优先，P2 落库 session.status 兜底
      const presentation = getSessionStatusPresentation({
        taskState: state,
        sessionStatus: session?.status,
      });
      const status = sessionStatusKindToTaskStatus(presentation.kind);
      return {
        id: `global:${sessionId}`,
        scope: 'global' as const,
        title: session
          ? getDisplaySessionTitle(session.title, args.language)
          : t.sessionReplay.dialog.ledgerSessionFallback.replace('{id}', sessionId.slice(0, 8)),
        status,
        steps: [{
          title: state.status === 'queued' && state.queuePosition !== undefined
            ? t.sessionReplay.dialog.ledgerQueuePosition.replace('{position}', String(state.queuePosition))
            : presentation.label,
          status,
        }],
        ownerRunId: null,
        sourceThreadId: sessionId,
        resumeHint: state.error,
      };
    });
}

function backgroundTaskStatusToTaskStatus(status: Task['status']): TaskRecord['status'] {
  if (status === 'running' || status === 'queued' || status === 'paused' || status === 'waiting_input' || status === 'stalled') {
    return 'in_progress';
  }
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed' || status === 'expired' || status === 'orphaned') return 'blocked';
  return 'pending';
}

function backgroundTaskStatusLabel(task: Task, t: Translations): string {
  if (task.failure?.reason === BACKGROUND_TASK_DELETE_INCOMPLETE) return t.outcomeWords['delete-incomplete'].detail.label;
  const dialog = t.sessionReplay.dialog;
  switch (task.status) {
    case 'queued':
      return dialog.taskQueued;
    case 'running':
      return dialog.running;
    case 'waiting_input':
      return dialog.taskWaitingInput;
    case 'stalled':
      return task.progress?.label
        ? dialog.taskStalledLabel.replace('{label}', task.progress.label)
        : dialog.taskStalled;
    case 'completed':
      return dialog.completed;
    case 'failed':
      return dialog.failed;
    case 'cancelled':
      return dialog.cancelled;
    case 'paused':
      return dialog.taskPaused;
    case 'expired':
      return dialog.taskExpired;
    case 'orphaned':
      return dialog.taskOrphaned;
    default:
      return task.status;
  }
}

function workflowStatusToTaskStatus(status: ScriptRunSnapshot['status']): TaskRecord['status'] {
  return longTaskUiStatusToTaskStatus(normalizeLongTaskStatus(status));
}

function longTaskUiStatusToTaskStatus(status: LongTaskUiStatus): TaskRecord['status'] {
  if (status === 'queued' || status === 'running' || status === 'waiting_approval' || status === 'paused') {
    return 'in_progress';
  }
  if (status === 'completed') return 'completed';
  return 'blocked';
}

function workflowStatusLabel(snapshot: ScriptRunSnapshot): string {
  const status = normalizeLongTaskStatus(snapshot.status);
  switch (status) {
    case 'running':
      return snapshot.currentPhase ? `执行中：${snapshot.currentPhase}` : '执行中';
    default:
      return getLongTaskStatusLabel(status);
  }
}

export function buildWorkflowTaskRecord(snapshot: ScriptRunSnapshot | undefined): TaskRecord | null {
  if (!snapshot) return null;
  const status = workflowStatusToTaskStatus(snapshot.status);
  const totals = buildWorkflowTimeline(snapshot).totals;
  const agentSummary = [
    totals.running > 0 ? `${totals.running} ${getLongTaskStatusLabel('running')}` : null,
    totals.done > 0 ? `${totals.done} ${getLongTaskStatusLabel('completed')}` : null,
    totals.error > 0 ? `${totals.error} ${getLongTaskStatusLabel('failed')}` : null,
  ].filter(Boolean).join(' · ');

  return {
    id: `workflow:${snapshot.runId}`,
    scope: 'session',
    title: snapshot.goal ? `Workflow: ${snapshot.goal}` : 'Workflow run',
    status,
    steps: [
      {
        title: workflowStatusLabel(snapshot),
        status,
      },
      ...(agentSummary ? [{
        title: agentSummary,
        status,
      }] : []),
    ],
    ownerRunId: snapshot.runId,
    sourceThreadId: snapshot.sessionId ?? null,
    resumeHint: snapshot.error,
    outputRefs: [{
      id: `workflow:${snapshot.runId}:replay`,
      type: 'replay',
      label: 'Workflow replay',
    }],
  };
}

function workflowAgentStatus(agent: ScriptRunAgentSnapshot): LongTaskUiStatus {
  return normalizeLongTaskStatus(agent.status);
}

export function buildWorkflowSubagentViews(snapshot: ScriptRunSnapshot | undefined): SubagentRunView[] {
  if (!snapshot) return [];
  return snapshot.agents.map((agent) => ({
    id: `workflow:${snapshot.runId}:${agent.id}`,
    parentRunId: snapshot.runId,
    role: agent.label || 'workflow agent',
    model: agent.model,
    status: workflowAgentStatus(agent),
    inputSummary: agent.promptPreview || agent.phase || snapshot.goal || 'workflow agent',
    lastOutput: agent.resultPreview || agent.error || '',
    resultSummary: agent.resultPreview,
    handoff: agent.error,
  }));
}

function formatBackgroundTaskDuration(durationMs?: number): string | null {
  if (!durationMs || durationMs < 0) return null;
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function stringFromMetadata(metadata: Task['metadata'], key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function lastPathSegment(value: string | undefined): string | null {
  if (!value) return null;
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function outputRefTypeLabel(type: string, t: Translations): string {
  switch (type) {
    case 'log':
      return t.sessionReplay.dialog.outputRefRunLog;
    case 'text':
      return t.sessionReplay.dialog.outputRefFinalOutput;
    case 'report':
      return t.taskStatusPanels.runWorkbench.report;
    case 'trace':
      return 'Trace';
    case 'replay':
      return 'Replay';
    case 'url':
      return t.taskStatusPanels.runWorkbench.link;
    case 'file':
    case 'artifact':
      return t.taskStatusPanels.runWorkbench.artifact;
    default:
      return t.taskStatusPanels.runWorkbench.output;
  }
}

function buildTaskOutputRefs(task: Task, t: Translations): TaskRecordOutputRef[] {
  const shell = isShellBackgroundTask(task);
  const refs = task.outputRefs
    .map((ref): TaskRecordOutputRef => {
      if (shell && ref.type === 'log') {
        return { id: ref.id, taskId: task.id, type: 'log', label: t.taskStatusPanels.runWorkbench.viewLog, size: ref.size };
      }
      const pathOrUrl = ref.path || ref.uri || undefined;
      const fallbackLabel = lastPathSegment(pathOrUrl) || outputRefTypeLabel(ref.type, t);
      return {
        id: ref.id,
        taskId: task.id,
        type: ref.type,
        label: ref.label || fallbackLabel,
        pathOrUrl,
        size: ref.size,
      };
    })
    .filter((ref) => ref.label || ref.pathOrUrl);

  const metadataLogPath = stringFromMetadata(task.metadata, 'logPath');
  if (!shell && metadataLogPath && !refs.some((ref) => ref.type === 'log' && ref.pathOrUrl === metadataLogPath)) {
    refs.unshift({
      id: `${task.id}:metadata-log`,
      type: 'log',
      label: outputRefTypeLabel('log', t),
      pathOrUrl: metadataLogPath,
    });
  }

  return refs.slice(0, 4);
}

function recordFromMetadata(metadata: Task['metadata'] | undefined, key: string): Record<string, unknown> | null {
  const value = metadata?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function formatOutputRefStep(ref: TaskRecordOutputRef, t: Translations): string {
  const name = lastPathSegment(ref.pathOrUrl) || ref.label;
  const label = ref.label || outputRefTypeLabel(ref.type, t);
  return name && name !== label
    ? t.sessionReplay.dialog.outputRefNamed.replace('{label}', label).replace('{name}', name)
    : label;
}

interface BackgroundTaskResume {
  hint?: string;
  /** 失败原因是 raw 日志、被语义化清洗掉时的类别；渲染层用 taskBlockedReason[category] 兜底 */
  blockedCategory?: TaskBlockedCategory;
}

function backgroundTaskResumeHint(
  task: Task, outputRefs: TaskRecordOutputRef[], language: Language,
): BackgroundTaskResume {
  // 完成产物由会话流承担唯一展示；右侧概览只保留“已完成”状态。
  // 这里若再返回 final ref/summary，TaskPanel 会把同一产物重新做成结果卡。
  if (task.status === 'completed') return {};
  const t = languages[language];
  const recoveryPlan = recordFromMetadata(task.metadata, 'recoveryPlan');
  const recoverySummary = typeof recoveryPlan?.summary === 'string' ? recoveryPlan.summary : null;
  if (isShellBackgroundTask(task) && task.status === 'failed') {
    // Older Automation prompt records may have only a recovery summary.
    if (!task.failure && recoverySummary) return { hint: recoverySummary };
    const failure = backgroundTaskFailureCopy(task, t);
    return failure ? {
      hint: withAutomationPromptTimeoutHint(failure, language, task.metadata?.automationPromptLikely === true),
    } : {};
  }
  if (isShellBackgroundTask(task) && ['running', 'cancelled'].includes(task.status)) return {};
  if (recoverySummary) return { hint: recoverySummary };

  if (task.failure?.reason === BACKGROUND_TASK_DELETE_INCOMPLETE) {
    return { hint: backgroundTaskFailureCopy(task, languages[language]) ?? undefined };
  }

  if (!isShellBackgroundTask(task) && task.failure?.message) {
    // 失败原因先过语义化清洗（ADR-050 / FB-746）：「Cannot read properties of …」这类
    // raw JS 异常清洗为空时不进行，改走 blockedCategory 的 i18n 类别文案；
    // 原始 message 仍留在 task.failure 里供排错，不在这一行露出。
    const { reason, category } = describeTaskBlockedReason(task.failure.message);
    if (reason) return { hint: reason };
    return { blockedCategory: category };
  }
  if (task.status === 'stalled' && task.progress?.label) return { hint: task.progress.label };

  const finalRef = outputRefs.find((ref) => ref.type === 'text' || ref.type === 'report' || ref.type === 'artifact' || ref.type === 'file');
  if (finalRef) {
    const name = lastPathSegment(finalRef.pathOrUrl) || finalRef.label;
    return {
      hint: t.sessionReplay.dialog.outputRefNamed
        .replace('{label}', t.sessionReplay.dialog.outputRefFinalOutput)
        .replace('{name}', name),
    };
  }

  const logRef = outputRefs.find((ref) => ref.type === 'log');
  if (logRef && (task.status === 'running' || task.status === 'stalled')) {
    const name = lastPathSegment(logRef.pathOrUrl) || logRef.label;
    return {
      hint: t.sessionReplay.dialog.outputRefNamed
        .replace('{label}', t.taskStatusPanels.runWorkbench.log)
        .replace('{name}', name),
    };
  }

  return task.summary && !isShellBackgroundTask(task) ? { hint: task.summary } : {};
}

export function buildLedgerTaskRecords(tasks: Task[], currentSessionId: string | null, language: Language): TaskRecord[] {
  if (!currentSessionId) return [];
  const t = languages[language];

  const sessionTasks = tasks.filter((task) => task.sessionId === currentSessionId);
  // 序号按会话账本全集算（与成员列表、回放摘要同源），不受下面 slice 影响
  const labels = backgroundTaskLabels(sessionTasks, t);
  return sessionTasks
    .slice(0, 8)
    .map((task) => {
      const status = backgroundTaskStatusToTaskStatus(task.status);
      const outputRefs = task.status === 'completed' ? [] : buildTaskOutputRefs(task, t);
      const duration = formatBackgroundTaskDuration(task.durationMs);
      const resume = backgroundTaskResumeHint(task, outputRefs, language);
      return {
        id: `background:${task.id}`,
        scope: 'global' as const,
        title: task.title,
        source: task.source,
        displayTitle: labels.get(task.id),
        status,
        ...(status === 'blocked' ? { failed: true } : {}),
        steps: [
          {
            title: backgroundTaskStatusLabel(task, t),
            status,
          },
          ...(duration ? [{
            title: duration,
            status,
          }] : []),
          ...outputRefs.map((ref) => ({
            title: formatOutputRefStep(ref, t),
            status,
          })),
        ],
        ownerRunId: task.runId ?? null,
        sourceThreadId: task.sessionId ?? null,
        resumeHint: resume.hint,
        ...(resume.blockedCategory ? { resumeHintCategory: resume.blockedCategory } : {}),
        outputRefs,
      };
    });
}

export function buildDurableSubagentViews(args: {
  runId: string | null;
  agents: SwarmRunAgentRecord[];
  selectedAgentId: string | null;
  language: Language;
}): SubagentRunView[] {
  const t = languages[args.language];
  return args.agents.map((agent) => {
    const status = normalizeLongTaskStatus(agent.status);
    return {
      id: agent.agentId,
      parentRunId: args.runId,
      role: agent.name || agent.role || 'Agent',
      status,
      inputSummary: agent.dispatchedTask || agent.role || t.sessionReplay.dialog.subagentWaitingTask,
      lastOutput: agent.finalOutput || (agent.agentId === args.selectedAgentId ? t.sessionReplay.dialog.subagentCurrentSelected : ''),
      resultSummary: agent.finalOutput,
      handoff: agent.error ?? undefined,
    };
  });
}

export function useRunWorkbenchModel(): RunWorkbenchModel {
  const projection = useCurrentTurnExecutionProjection();
  const statusRail = useStatusRailModel();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessionStates = useTaskStore((state) => state.sessionStates);
  const sessionTaskProgress = useAppStore((state) => state.sessionTaskProgress);
  const pendingPermissionRequest = useAppStore((state) => state.pendingPermissionRequest);
  const pendingPermissionSessionId = useAppStore((state) => state.pendingPermissionSessionId);
  const language = useAppStore((state) => state.language);
  const selectedSwarmAgentId = useAppStore((state) => state.selectedSwarmAgentId);
  const backgroundTasks = useBackgroundTaskStore((state) => state.tasks);
  const workflowSnapshot = useWorkflowStore((state) => state.activeSnapshot(currentSessionId ?? undefined));
  const sessionTasks = useSessionStore((state) => state.sessionTasks);
  const durableSwarmDetail = useDurableSwarmRunDetail(currentSessionId);

  const taskProgress = currentSessionId ? sessionTaskProgress[currentSessionId] ?? null : null;
  const sessionStatus = currentSessionId ? sessionStates[currentSessionId]?.status ?? null : null;
  const pendingApprovalId = pendingPermissionSessionId === currentSessionId
    ? pendingPermissionRequest?.id ?? null
    : null;

  return useMemo(() => {
    const run = buildRunUiState({
      projection,
      sessionId: currentSessionId,
      sessionStatus,
      taskProgress,
      todos: statusRail.todos.items,
      pendingApprovalId,
      language: language === 'en' ? 'en' : 'zh',
      backgroundTasks,
    });
    const sessionTask = buildSessionTaskRecord({
      sessionId: currentSessionId,
      runId: run.identity.runId,
      runStatus: run.status,
      sessionTasks,
      todos: statusRail.todos.items,
      taskProgress,
      language: language === 'en' ? 'en' : 'zh',
    });
    const ledgerTasks = buildLedgerTaskRecords(backgroundTasks, currentSessionId, language);
    const workflowTask = buildWorkflowTaskRecord(workflowSnapshot);
    const workflowSubagents = buildWorkflowSubagentViews(workflowSnapshot);

    return {
      run,
      loopDecisions: buildLoopDecisionViews(projection),
      tools: buildSessionToolCapabilityViews(projection),
      tasks: [
        ...(sessionTask ? [sessionTask] : []),
        ...(workflowTask ? [workflowTask] : []),
        ...ledgerTasks,
      ],
      subagents: buildDurableSubagentViews({
        runId: run.identity.runId,
        agents: durableSwarmDetail?.agents ?? [],
        selectedAgentId: selectedSwarmAgentId,
        language,
      }).concat(workflowSubagents),
      memoryActivities: buildSessionMemoryActivityEvents(projection),
      outputs: buildOutputArtifactViews(projection),
    };
  }, [
    backgroundTasks,
    currentSessionId,
    durableSwarmDetail,
    language,
    pendingApprovalId,
    projection,
    selectedSwarmAgentId,
    sessionStates,
    sessionStatus,
    sessionTasks,
    statusRail.todos.items,
    taskProgress,
    workflowSnapshot,
  ]);
}
