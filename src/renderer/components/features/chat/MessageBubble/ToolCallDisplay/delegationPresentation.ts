import { agentNodeLabel, backgroundTaskLabel } from '../../../../../utils/agentRoleLabel';
import { humanizeToolStep, parseDelegateSessionReceipt } from '../../../../../utils/humanizeToolStep';
import { AgentFailureCode } from '@shared/contract/agentFailure';
import type { AgentTreeNode } from '@shared/contract/agentTree';
import type { LastToolFailure, LastToolStep, Task, TaskOutputRef } from '@shared/contract/backgroundTask';
import type { ToolCall } from '@shared/contract';
import { languages, type Translations } from '../../../../../i18n';
import { useAppStore } from '../../../../../stores/appStore';
import { agentFailureCopy, backgroundTaskFailureCopy } from '../../../../../utils/agentFailureCopy';
import { isToolInterruptionPlaceholder } from '../../../../../utils/toolExecutionPresentation';
import {
  isAgentNodeTerminalStatus,
  isLastToolFailureVisible,
  isTaskTerminalStatus,
  taskActivityIds,
} from '../../../../../utils/agentActivity';

type DelegationReceiptState = 'working' | 'completed' | 'failed' | 'cancelled';

interface DelegationReceiptOutput {
  id: string;
  label: string;
  target: string;
  kind: 'file' | 'url';
}

export interface DelegationPresentation {
  state: DelegationReceiptState;
  title: string;
  lastToolStep?: LastToolStep;
  stepCount?: number;
  outputs: DelegationReceiptOutput[];
  failure?: string;
  /** 子代理在隔离副本里改了文件时，等待合并的分支名（不含路径）。 */
  branch?: string;
  failureCode?: AgentFailureCode;
  /** 终态任务的结构化工具失败（N-MEDIA-GEN-MUSIC-FALLBACK-FU1）：回执行人话出路用。 */
  toolFailure?: LastToolFailure;
  /** 审批关联键（agentRows.applyMemberHolds 同口径）：task.id / runId / childRunId 或节点 id。 */
  activityIds: readonly string[];
  /** 任务归属会话；agentTree 节点路径没有，审批作用域由 resolveAgentActivityStepStatus 兜底。 */
  sessionId?: string;
  /** delegate_session 回执：委托目标会话 id（来自工具结果 metadata，模型不可见）。 */
  targetSessionId?: string;
  /** 失败回执「查看详情」的成员 id（agentTree 节点 id / 后台任务 id），与成员条 chip 打开的是同一个成员视图。 */
  memberId?: string;
  /** 失败回执「重试」草稿里的任务标题（来自派发时的任务描述，不是角色名）。 */
  retryTitle?: string;
}

const TASK_STATS_MARKER = '\nStats:\n';
const RESULT_TOOLS = new Set(['Task', 'spawn_agent', 'AgentSpawn', 'wait_agent']);

function reportBody(output: string): string {
  const text = output.replace(/\r\n/g, '\n');
  const envelope = /^Agent \[[^\n]+\] completed[^\n]*:\n\n/.exec(text);
  if (!envelope) return text;
  const resultMarker = envelope[0].endsWith(' completed task:\n\n')
    ? text.indexOf('\n\nResult:\n')
    : -1;
  const start = resultMarker >= 0 ? resultMarker + '\n\nResult:\n'.length : envelope[0].length;
  const stats = text.lastIndexOf(TASK_STATS_MARKER);
  const body = text.slice(start, stats >= start ? stats : undefined).trim();
  if (stats < start) return body;
  // Stats are internal bookkeeping, but these two lines are actionable for the user.
  const notes = text.slice(stats).split('\n').filter((line) => /^- (?:Worktree|Missing tools): /.test(line));
  return notes.length ? `${body}\n\n${notes.join('\n')}` : body;
}

// Display-only filenames: preserve public URLs and relative paths, including report content.
function displayPaths(text: string): string {
  return text
    .replace(/(["'`])((?:file:\/\/)?(?:\/(?:Users|home|tmp|var|private|workspace|workspaces|Volumes|mnt|opt|srv)\/|[A-Za-z]:[\\/])[^\n]*?)\1/g,
      (_match, quote: string, path: string) => `${quote}${basename(path)}${quote}`)
    .replace(/(^|[\s(<（：，「【、])(?:file:\/\/)?((?:\/(?:Users|home|tmp|var|private|workspace|workspaces|Volumes|mnt|opt|srv)\/|[A-Za-z]:[\\/])[^\s"'`<>()[\]（）：，。「」【】、]+)/g,
      (_match, prefix: string, path: string) => `${prefix}${basename(path)}`);
}

function displayArgument(value: unknown): unknown {
  if (typeof value === 'string') return displayPaths(value);
  if (Array.isArray(value)) return value.map(displayArgument);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, displayArgument(child)]));
  }
  return value;
}

function waitReport(output: string, t: Translations): string {
  return output.replace(/^Wait results \([^\n]*\):\n*/, '').split('\n').flatMap((line) => {
    const status = /^\S+ \[[^\]]+\] .* — ([\w-]+) \([^\n]*\)$/.exec(line)?.[1];
    if (status) {
      if (status === 'completed') return [];
      return [status === 'running' || status === 'running-recovered'
        ? t.chat.delegationReceipt.working
        : t.chat.delegationReceipt.failed];
    }
    if (/^ {3}(?:Stats: \d+ iterations, \d+ tools|Still in progress after \d+ms timeout)/.test(line)) return [];
    if (/^\[[^\]]+\] NOT FOUND$/.test(line)) return [t.chat.delegationReceipt.failed];
    return [line.replace(/^ {3}Result: /, '').replace(/^ {3}Error: /, `${t.chat.delegationReceipt.failed}: `)];
  }).join('\n').trim();
}

function withoutRepeatedReport(toolCall: ToolCall): ToolCall {
  const result = toolCall.result;
  const metadata = result?.metadata;
  const nested = metadata?.result;
  if (!result?.success || typeof result.output !== 'string'
    || metadata?.artifactRole !== 'multiagent-result'
    || !nested || typeof nested !== 'object' || Array.isArray(nested)) return toolCall;
  const fields = nested as Record<string, unknown>;
  if (typeof fields.output !== 'string' || !fields.output.trim()) return toolCall;

  // Compare the report itself, excluding only the producer's known receipt envelope.
  // A matching prefix/subset is not enough: different findings must remain available.
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  const candidate = normalize(fields.output);
  const report = reportBody(result.output);
  if (normalize(result.output) !== candidate && normalize(report) !== candidate) return toolCall;

  const displayFields = { ...fields };
  delete displayFields.output;
  return {
    ...toolCall,
    result: { ...result, metadata: { ...metadata, result: displayFields } },
  };
}

/** Keep stored/model-facing receipts intact; project the user's report for every card surface. */
export function toDelegationDisplayToolCall(
  storedToolCall: ToolCall,
  t: Translations,
  /** 子代理节点/任务的实时状态：交接回执落库后不会改写，终态时用它收口，避免「已完成」旁还写着「工作中」。 */
  presentation?: Pick<DelegationPresentation, 'state'> | null,
): ToolCall {
  if (!RESULT_TOOLS.has(storedToolCall.name)
    && storedToolCall.result?.metadata?.artifactRole !== 'multiagent-result') return storedToolCall;
  const toolCall = withoutRepeatedReport(storedToolCall);
  const result = toolCall.result;
  const shortDescription = toolCall.shortDescription;
  let output = result?.output;
  if (typeof output === 'string') {
    if (result?.success) {
      if (/^Agent \[[^\n]+\] (?:exceeded foreground budget and continues in background|spawned in background):/.test(output)
        || /^已在后台开始处理「/.test(output)) {
        // 没有子代理的实时事实（树未载入/节点已不在）时不下断言：既不说「工作中」也不说「已完成」。
        output = !presentation
          ? ''
          : presentation.state === 'working'
            ? t.chat.delegationReceipt.working
            : t.chat.delegationReceipt[presentation.state];
      } else {
        output = toolCall.name === 'wait_agent' ? waitReport(output, t) : reportBody(output);
      }
    }
    output = displayPaths(output);
  }
  return {
    ...toolCall,
    arguments: displayArgument(toolCall.arguments) as ToolCall['arguments'],
    ...(shortDescription ? {
      // Model-authored bookkeeping such as "Use spawn_agent" must not override
      // the existing localized tool-action template (including in English UI).
      shortDescription: [...RESULT_TOOLS].some((name) => shortDescription.includes(name))
        ? undefined
        : displayPaths(shortDescription),
    } : {}),
    ...(result ? { result: { ...result, output } } : {}),
  };
}

function basename(value: string): string {
  const normalized = value.split(/[?#]/, 1)[0] || value;
  return normalized.split(/[\\/]/).filter(Boolean).pop() || value;
}

function taskOutput(ref: TaskOutputRef): DelegationReceiptOutput | undefined {
  const target = ref.path || ref.uri;
  if (!target) return undefined;
  return {
    id: ref.id,
    label: basename(target) || ref.label || target,
    target,
    kind: ref.path ? 'file' : 'url',
  };
}

function completedStepCount(step: LastToolStep | undefined, current: number | undefined): number | undefined {
  const indexed = step?.toolIndex === undefined ? undefined : step.toolIndex + 1;
  const count = Math.max(current ?? 0, indexed ?? 0);
  return count > 0 ? count : undefined;
}

function fromTask(task: Task, t: Translations): DelegationPresentation {
  const terminal = isTaskTerminalStatus(task.status);
  const state: DelegationReceiptState = !terminal
    ? 'working'
    : task.status === 'completed'
      ? 'completed'
      : task.status === 'cancelled'
        ? 'cancelled'
        : 'failed';
  return {
    state,
    title: displayPaths(backgroundTaskLabel(task, t)),
    lastToolStep: task.progress?.lastToolStep,
    activityIds: taskActivityIds(task),
    sessionId: task.sessionId,
    stepCount: terminal
      ? completedStepCount(task.progress?.lastToolStep, task.progress?.current)
      : undefined,
    outputs: task.outputRefs.flatMap((ref) => {
      const output = taskOutput(ref);
      return output ? [output] : [];
    }),
    failure: state === 'failed'
      ? backgroundTaskFailureCopy(task, t) ?? agentFailureCopy(AgentFailureCode.Unknown, t) ?? undefined
      : undefined,
    memberId: task.id,
    toolFailure: isLastToolFailureVisible(task.status) ? task.progress?.lastToolFailure : undefined,
  };
}

function extractSpawnAgentId(toolCall: ToolCall): string | undefined {
  const metadataAgentId = toolCall.result?.metadata?.agentId;
  if (typeof metadataAgentId === 'string' && metadataAgentId.trim()) return metadataAgentId.trim();
  const match = toolCall.result?.output?.match(/^- Agent ID:\s*(\S+)\s*$/m);
  return match?.[1];
}

function fromAgent(node: AgentTreeNode, t: Translations): DelegationPresentation {
  const state: DelegationReceiptState = node.status === 'completed'
    ? 'completed'
    : isAgentNodeTerminalStatus(node.status)
      ? 'failed'
      : 'working';
  const terminal = state !== 'working';
  return {
    state,
    title: agentNodeLabel(node, t.agentRoleLabels),
    lastToolStep: node.lastToolStep,
    activityIds: [node.id],
    stepCount: terminal ? completedStepCount(node.lastToolStep, undefined) : undefined,
    outputs: node.evidenceRefs.flatMap((ref) => {
      if (ref.kind !== 'file' && ref.kind !== 'artifact') return [];
      return [{
        id: ref.id,
        label: basename(ref.ref),
        target: ref.ref,
        kind: ref.ref.startsWith('http://') || ref.ref.startsWith('https://') ? 'url' as const : 'file' as const,
      }];
    }),
    // progress 是子代理最后一段工具输出，不是失败原因：重启后 failureCode/Reason 丢失时
    // 宁可落「原因暂不明确」，也不能把原始工具回显当原因展示给用户。
    failure: state === 'failed'
      ? agentFailureCopy(node.failureCode, t, node.failureReason) ?? agentFailureCopy(AgentFailureCode.Unknown, t) ?? undefined
      : undefined,
    memberId: node.id,
    branch: terminal && node.worktreeState.status === 'preserved' ? node.worktreeState.branch : undefined,
    failureCode: state === 'failed' ? node.failureCode : undefined,
  };
}

function retryTitleFrom(toolCall: ToolCall): string | undefined {
  const args = toolCall.arguments ?? {};
  const raw = [args.title, args.task, args.description, args.prompt].find((value) => typeof value === 'string' && value.trim());
  if (typeof raw !== 'string') return undefined;
  const line = raw.split('\n').map((part) => part.trim()).find((part) => part && !/^\[工作目录[:：]/.test(part));
  if (!line) return undefined;
  const title = displayPaths(line);
  return title.length > 60 ? `${title.slice(0, 60)}…` : title;
}

export function deriveDelegationPresentation(
  toolCall: ToolCall,
  tasks: Task[],
  agentNodes: AgentTreeNode[],
  t: Translations = languages[useAppStore.getState().language] ?? languages.zh,
): DelegationPresentation | null {
  const presentation = derivePresentation(toolCall, tasks, agentNodes, t);
  if (presentation?.state !== 'failed') return presentation;
  return { ...presentation, retryTitle: retryTitleFrom(toolCall) ?? presentation.title };
}

function derivePresentation(
  toolCall: ToolCall,
  tasks: Task[],
  agentNodes: AgentTreeNode[],
  t: Translations,
): DelegationPresentation | null {
  if (!toolCall.result) return null;
  if (toolCall.name === 'delegate_session') {
    const delegationReceipt = parseDelegateSessionReceipt(toolCall.result);
    if (!delegationReceipt || !t) return null;
    return {
      state: 'completed',
      title: humanizeToolStep(toolCall.name, toolCall.arguments, t, undefined, 'completed', undefined, { delegationReceipt }),
      outputs: [],
      activityIds: [],
      ...(typeof toolCall.result.metadata?.targetSessionId === 'string' && toolCall.result.metadata.targetSessionId
        ? { targetSessionId: toolCall.result.metadata.targetSessionId } : {}),
    };
  }
  if (toolCall.name === 'delegate_task') {
    const receipt = toolCall.result.metadata?.sessionTask as { tasks?: Array<{ taskId?: unknown }> } | undefined;
    const taskId = Array.isArray(receipt?.tasks) && receipt.tasks.length === 1 && typeof receipt.tasks[0]?.taskId === 'string'
      ? receipt.tasks[0].taskId : undefined;
    const task = tasks.find((candidate) => candidate.toolCallId === toolCall.id
      || (taskId !== undefined && candidate.id === taskId));
    return task ? fromTask(task, t) : null;
  }
  if (toolCall.name === 'spawn_agent') {
    const agentId = extractSpawnAgentId(toolCall);
    if (agentId) {
      const node = agentNodes.find((candidate) => candidate.id === agentId || candidate.backgroundAgentId === agentId);
      return node ? fromAgent(node, t) : null;
    }
    // A crash can persist the dispatched call before its result records the child id.
    // The session-scoped tree may already have the recovered child's stronger fact.
    // Only an exact, unique task match for an interrupted background spawn is safe.
    const task = toolCall.arguments?.task;
    if (toolCall.arguments?.run_in_background !== true || typeof task !== 'string' || !task.trim()
      || !isToolInterruptionPlaceholder(toolCall.result.error)
      || !toolCall.result.error?.toLowerCase().includes('process crashed')) return null;
    const matches = agentNodes.filter((node) => node.background
      && node.failureCode === AgentFailureCode.ParentGone && node.task === task);
    return matches.length === 1 ? fromAgent(matches[0], t) : null;
  }
  return null;
}

export function resolveAgentActivityTarget(
  step: LastToolStep | undefined,
  agentNodes: AgentTreeNode[],
): LastToolStep | undefined {
  if (!step?.target) return step;
  const peer = agentNodes.find((candidate) => candidate.id === step.target);
  return peer ? { ...step, target: peer.role } : step;
}
