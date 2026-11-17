import { isClosedTaskStatus, statusRequiresWaitReason } from '@shared/contract/planning';
import type { RunUiState, TaskRecord } from '../types/runWorkbench';
import type { Translations } from '../i18n';
import { backgroundTaskLabel } from './agentRoleLabel';

type TaskRailMode = 'simple' | 'checklist';

export interface TaskRailStepView {
  title: string;
  status: TaskRecord['steps'][number]['status'];
  originalIndex: number;
  blockedByTitles?: string[];
  blockedTaskTitles?: string[];
  blockedReason?: string;
  blockedReasonCategory?: TaskRecord['steps'][number]['blockedReasonCategory'];
}

export interface TaskRailDependencySummary {
  waitingCount: number;
  unlockingCount: number;
}

export interface TaskRailView {
  mode: TaskRailMode;
  title: string;
  status: TaskRecord['status'];
  failed?: boolean;
  visibleSteps: TaskRailStepView[];
  completedSteps: TaskRailStepView[];
  hiddenCompletedCount: number;
  hiddenPendingCount: number;
  completed: number;
  total: number;
  taskCount: number;
  dependencySummary?: TaskRailDependencySummary;
  currentAction?: string;
  /** currentAction 被清洗掉时的类别；渲染层用 taskBlockedReason[category] 兜底（ADR-050） */
  currentActionCategory?: TaskRecord['resumeHintCategory'];
}

const UTILITY_STEP_PATTERNS = [
  /^read$/i,
  /^bash$/i,
  /^grep$/i,
  /^search$/i,
  /^工具[:：\s]/,
  /^tool[:：\s]/i,
  /^(读取|读)(文件|代码|目录|仓库|资料|文档)/,
  /^(运行|执行|跑)(命令|脚本|测试|构建)/,
  /^(联网|网络)?搜索(资料|信息|网页)?$/,
  /^调用(工具|接口|MCP)/i,
  /^第\s*\d+\/\d+\s*个工具$/,
  /^(文件读取|文件写入|命令执行|工具调用|搜索)活动$/,
];

function isUtilityStepTitle(title: string): boolean {
  const normalized = title.trim();
  if (!normalized) return true;
  return UTILITY_STEP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function statusLabel(status: TaskRecord['status']): string {
  switch (status) {
    case 'completed':
      return '已完成';
    case 'blocked':
      return '已阻塞';
    case 'cancelled':
      return '已取消';
    case 'pending':
      return '待开始';
    case 'needs_decision':
      return '等你拍板';
    case 'user_action':
      return '等你操作';
    case 'in_progress':
    default:
      return '正在处理';
  }
}

function runStatusLabel(run?: RunUiState | null): string | null {
  if (!run) return null;
  switch (run.status) {
    case 'completed':
      return '已完成';
    case 'blocked':
      return '已阻塞';
    case 'waiting_approval':
      return '等你确认';
    case 'planning':
      return '正在分析';
    case 'using_tools':
    case 'running':
    case 'verifying':
      return run.phase || '正在处理';
    case 'cancelled':
      return '已取消';
    default:
      return run.phase || null;
  }
}

function simpleTitle(title: string, task: TaskRecord, run?: RunUiState | null): string {
  // 有明确标题优先显示标题（行内已单独展示状态标签，无需用状态词顶替标题）——
  // 否则终态的后台任务（如"循环 · …"失败）会丢掉名字、只剩"已阻塞/已取消"。
  if (title) return title;
  if (isClosedTaskStatus(task.status) || statusRequiresWaitReason(task.status)) {
    return statusLabel(task.status);
  }
  return runStatusLabel(run) || statusLabel(task.status);
}

function toStepViews(task: TaskRecord): TaskRailStepView[] {
  return task.steps
    .map((step, index) => ({
      title: step.title.trim(),
      status: step.status,
      originalIndex: index,
      blockedByTitles: step.blockedByTitles,
      blockedTaskTitles: step.blockedTaskTitles,
      blockedReason: step.blockedReason,
      blockedReasonCategory: step.blockedReasonCategory,
    }))
    .filter((step) => step.title && !isUtilityStepTitle(step.title));
}

/** 多个后台任务都折叠成同一个兜底名时加序号（与 agentRows 同口径），否则任务栏里分不清谁是谁。 */
export function foldTaskRailTitles(tasks: TaskRecord[], t: Translations): Map<string, string> {
  const titles = new Map(tasks.map((task) => [task.id, backgroundTaskLabel(task, t)] as const));
  const fallback = t.agentRoleLabels.roles.background;
  const folded = tasks.filter((task) => task.source && titles.get(task.id) === fallback);
  if (folded.length > 1) folded.forEach((task, index) => titles.set(task.id, `${fallback} ${index + 1}`));
  return titles;
}

export function deriveTaskRailView(
  task: TaskRecord,
  run: RunUiState | null | undefined,
  t: Translations,
  foldedTitle?: string,
): TaskRailView {
  const title = foldedTitle ?? backgroundTaskLabel(task, t);
  const taskSteps = toStepViews(task);
  const waitingCount = taskSteps.filter((step) => (step.blockedByTitles?.length ?? 0) > 0).length;
  const unlockingCount = taskSteps.filter((step) => (step.blockedTaskTitles?.length ?? 0) > 0).length;
  const dependencySummary = waitingCount > 0 || unlockingCount > 0
    ? { waitingCount, unlockingCount }
    : undefined;
  const completed = taskSteps.filter((step) => step.status === 'completed').length;
  // 进度分母剔除已取消：取消的子任务不计入任务量，否则进度永远到不了 100%
  const total = taskSteps.filter((step) => step.status !== 'cancelled').length;
  const taskCount = taskSteps.length;
  // checklist（"已完成 N 个任务（共 M 个）"）只对会话内的真计划生效。
  // 后台/定时任务（global/scheduled）的 steps 是状态/时长/输出等元信息，不是子任务，
  // 不能当多任务清单渲染——否则单个后台任务会显示成"已完成 N 个任务（共 M 个）"。
  const isChecklist = task.scope === 'session' && taskSteps.length >= 2;
  const currentAction = task.resumeHint && task.resumeHint !== task.title ? task.resumeHint : undefined;
  const currentActionCategory = currentAction ? undefined : task.resumeHintCategory;

  if (!isChecklist) {
    return {
      mode: 'simple',
      title: simpleTitle(title, task, run),
      status: task.status,
      failed: task.failed,
      visibleSteps: [],
      completedSteps: [],
      hiddenCompletedCount: 0,
      hiddenPendingCount: 0,
      completed,
      total,
      taskCount,
      dependencySummary,
      currentAction,
      currentActionCategory,
    };
  }

  return {
    mode: 'checklist',
    title: title || runStatusLabel(run) || statusLabel(task.status),
    status: task.status,
    failed: task.failed,
    visibleSteps: taskSteps,
    completedSteps: [],
    hiddenCompletedCount: 0,
    hiddenPendingCount: 0,
    completed,
    total,
    taskCount,
    dependencySummary,
    currentAction,
    currentActionCategory,
  };
}
