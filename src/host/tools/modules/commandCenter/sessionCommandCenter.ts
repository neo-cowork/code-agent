import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { Message, MessageAttachment, UserQuestionOption } from '../../../../shared/contract';
import { CANCELLATION_TIMEOUTS } from '../../../../shared/constants/timeouts';
import {
  getSessionCommandCenter,
  type SessionCommandTask,
  type SessionTaskReferenceResult,
  type SpawnSessionTaskInput,
  type SpawnSessionTaskResult,
} from '../../../services/commandCenter/sessionCommandCenter';
import { resolveBackgroundWorkspaceAuthority } from '../../../runtime/workspaceAuthority';
import { promptUserInChat, type PromptUserResult } from '../../utils/userQuestionPrompt';
import { getAgentTreeSnapshot } from '../../../agent/agentTreeService';
import { formatBackgroundSubagentRows } from './backgroundSubagentTaskRows';
import {
  cancelTaskSchema,
  delegateTaskSchema,
  steerTaskSchema,
  taskStatusSchema,
} from './sessionCommandCenter.schema';

import { getSessionManager } from '../../../services/infra/sessionManager';
import { sessionTaskStatusLabel } from '../../../../shared/i18n/sessionTaskStatus';

const WORKSPACE_REQUIRED_MESSAGE = '没有可写的项目根，请先选择项目或添加目录。';
const OVERFLOW_QUESTION_HEADER = '任务已满';
const OVERFLOW_QUEUE_OPTION_LABEL = '排队';
const OVERFLOW_DECLINE_OPTION_LABEL = '暂不创建';
const OVERFLOW_REPLACE_OPTION_PREFIX = '替换';

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? args[key].trim() : '';
}

/** Keep the UI/reference key compact even when a provider emits an English phrase. */
export function normalizeSessionTaskShortName(value: string, title: string): string {
  const compact = value.replace(/\s+/g, '').trim();
  const chars = Array.from(compact);
  if (chars.length >= 2 && chars.length <= 4) return compact;

  if (chars.length > 4) {
    const words = compact.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g);
    if (words && words.length >= 2) {
      const initials = words.map((word) => Array.from(word)[0]).join('').toUpperCase();
      if (Array.from(initials).length >= 2 && Array.from(initials).length <= 4) return initials;
    }
    return chars.slice(0, 4).join('');
  }

  const titleChars = Array.from(title.replace(/\s+/g, '').trim());
  const fallback = [...chars, ...titleChars, ...Array.from('任务')].slice(0, 4).join('');
  return Array.from(fallback).length >= 2 ? fallback : '任务';
}

function requireSession(ctx: ToolContext): ToolResult<string> | string {
  return ctx.sessionId?.trim() || { ok: false, error: 'No active session', code: 'DOMAIN_ERROR' };
}

function describeReferenceFailure(result: SessionTaskReferenceResult, action: string, sessionId: string): string {
  if (result.outcome === 'missing') return `没有找到可${action}的活跃任务，什么都没改。请先核对当前任务。`;
  if (result.outcome === 'ambiguous') {
    const active = getSessionCommandCenter().active(sessionId);
    const options = result.candidates.map((task) => `第${active.findIndex((entry) => entry.id === task.id) + 1}个「${task.shortName}」`).join('、');
    return `目标不唯一，什么都没改。请让用户从这些任务中选择（可用序号指定）：${options}。`;
  }
  return '';
}

async function permit(
  schemaName: string,
  args: Record<string, unknown>,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string> | null> {
  const decision = await canUseTool(schemaName, args);
  return decision.allow
    ? null
    : { ok: false, error: `permission denied: ${decision.reason}`, code: 'PERMISSION_DENIED' };
}

export function describeDelegateTaskResult(result: Exclude<SpawnSessionTaskResult, { outcome: 'requires_choice' }>): string {
  const { task } = result;
  const retryContext = task.retryOf
    ? `这是第 ${task.attempt} 次尝试；上一次${sessionTaskStatusLabel(task.retryOf.status)}${task.retryOf.detail ? `：${task.retryOf.detail}` : '。'}`
    : '';
  if (result.outcome === 'reused') {
    return `继续跟踪「${task.shortName}」，当前${sessionTaskStatusLabel(task.status)}${task.detail ? `：${task.detail}` : '。'}${task.attempt > 1 ? `这是第 ${task.attempt} 次尝试。` : ''}`;
  }
  if (result.outcome === 'queued') {
    return `已把「${task.shortName}」加入排队，空闲后自动开始。${retryContext}`;
  }
  return `后台任务「${task.shortName}」已开始，尚未完成；完成后会在这里告诉你结果。${retryContext}`;
}

function sessionTaskMeta(
  outcome: 'accepted' | 'queued' | 'reused' | 'status',
  tasks: SessionCommandTask[],
  includeTaskIds = false,
): Record<string, unknown> {
  return {
    sessionTask: {
      outcome,
      tasks: tasks.map((task) => {
        const detail = task.resultText ?? task.detail ?? task.summary;
        return { ...(includeTaskIds ? { taskId: task.id } : {}), shortName: task.shortName, status: task.status, ...(detail ? { detail } : {}) };
      }),
    },
  };
}

function delegateTaskReceipt(
  result: Exclude<SpawnSessionTaskResult, { outcome: 'requires_choice' }>,
  prefix = '',
  includeTaskIds = false,
): ToolResult<string> {
  return {
    ok: true,
    output: prefix + describeDelegateTaskResult(result),
    meta: sessionTaskMeta(result.outcome === 'started' ? 'accepted' : result.outcome, [result.task], includeTaskIds),
  };
}

export async function executeDelegateTask(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
  includeTaskIds = false,
): Promise<ToolResult<string>> {
  const denied = await permit(delegateTaskSchema.name, args, canUseTool);
  if (denied) return denied;
  const session = requireSession(ctx);
  if (typeof session !== 'string') return session;
  const title = stringArg(args, 'title');
  const rawShortName = stringArg(args, 'short_name');
  const laneKey = stringArg(args, 'lane_key');
  const submissionKey = stringArg(args, 'submission_key');
  const prompt = stringArg(args, 'prompt');
  if (!title || !rawShortName || !laneKey || !submissionKey || !prompt) {
    return { ok: false, error: 'title, short_name, lane_key, submission_key and prompt are required', code: 'INVALID_ARGS' };
  }
  const shortName = normalizeSessionTaskShortName(rawShortName, title);
  if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };
  const workspaceScope = resolveBackgroundWorkspaceAuthority({
    workspace: ctx.workspace,
    workspaceScope: ctx.workspaceScope,
  });
  if (!workspaceScope) {
    return {
      ok: false,
      error: WORKSPACE_REQUIRED_MESSAGE,
      code: 'WORKSPACE_REQUIRED',
    };
  }

  onProgress?.({ stage: 'starting', detail: shortName });
  const spawnInput: SpawnSessionTaskInput = {
    sessionId: session,
    title,
    shortName,
    laneKey,
    submissionKey,
    prompt,
    workspaceScope,
    queueWhenFull: args.queue_when_full === true,
    attachments: ctx.subagent?.attachments as MessageAttachment[] | undefined,
    options: {
      mode: 'normal',
      toolScope: ctx.toolScope,
      executionIntent: ctx.executionIntent,
    },
    parentRunId: ctx.runId,
    parentTurnId: ctx.turnId,
    toolCallId: ctx.currentToolCallId,
  };
  const result = await getSessionCommandCenter().spawn(spawnInput);
  if (result.outcome === 'requires_choice') {
    const choiceResult = await resolveOverflowChoiceInHost(spawnInput, result.active, ctx, includeTaskIds, onProgress);
    onProgress?.({ stage: 'completing', percent: 100 });
    return choiceResult;
  }
  onProgress?.({ stage: 'completing', percent: 100 });
  return delegateTaskReceipt(result, '', includeTaskIds);
}

function buildOverflowQuestionOptions(
  shortName: string,
  active: SessionCommandTask[],
): { options: UserQuestionOption[]; replaceable: Array<{ label: string; task: SessionCommandTask }> } {
  const replaceable = active.slice(0, 2).map((task) => ({
    label: `${OVERFLOW_REPLACE_OPTION_PREFIX}${task.shortName}`,
    task,
  }));
  const options: UserQuestionOption[] = [
    { label: OVERFLOW_QUEUE_OPTION_LABEL, description: '等空闲槽位释放后自动开始。' },
    ...replaceable.map(({ label, task }) => ({
      label,
      description: `先停止「${task.shortName}」，再开始「${shortName}」。`,
    })),
    { label: OVERFLOW_DECLINE_OPTION_LABEL, description: '本次不创建后台任务。' },
  ];
  return { options, replaceable };
}

function describeOverflowUnansweredFallback(shortName: string): string {
  return `后台任务槽位已满，任务「${shortName}」尚未创建，也没有加入排队。如需排队等待空闲槽位，请回复“排队”。`;
}

function extractOverflowAnswer(result: PromptUserResult): string | undefined {
  if (result.status !== 'answered' || !result.response || result.response.declined === true) {
    return undefined;
  }
  const raw = result.response.answers[OVERFLOW_QUESTION_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function resolveOverflowChoiceInHost(
  spawnInput: SpawnSessionTaskInput,
  active: SessionCommandTask[],
  ctx: ToolContext,
  includeTaskIds: boolean,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const { abortSignal } = ctx;
  const { shortName, sessionId } = spawnInput;
  const { options, replaceable } = buildOverflowQuestionOptions(shortName, active);
  const question = replaceable.length > 0
    ? `当前后台任务槽位已满，「${shortName}」要排队等待，还是替换一件本会话的任务？`
    : `当前后台任务槽位已满，「${shortName}」要排队等待空闲槽位，还是暂不创建？`;

  onProgress?.({ stage: 'running', detail: `${OVERFLOW_QUESTION_HEADER}：${question} ${options.map((option) => option.label).join(' / ')}` });
  const promptResult = await promptUserInChat([{
    header: OVERFLOW_QUESTION_HEADER,
    question,
    options,
  }], {
    sessionId,
    abortSignal,
    notify: {
      title: OVERFLOW_QUESTION_HEADER,
      body: question,
    },
  });

  const answer = extractOverflowAnswer(promptResult);
  if (!answer) {
    const content = describeOverflowUnansweredFallback(shortName);
    // Persist the actionable receipt itself: a model paraphrase may omit the next step.
    const message: Message = { id: crypto.randomUUID(), role: 'assistant', content, timestamp: Date.now() };
    await getSessionManager().addMessageToSession(sessionId, message);
    ctx.emit({ type: 'message', data: message });
    return { ok: true, output: content };
  }
  if (answer === OVERFLOW_DECLINE_OPTION_LABEL) {
    return { ok: true, output: `用户选择了暂不创建，后台任务「${shortName}」未创建，也未加入排队。` };
  }
  if (answer === OVERFLOW_QUEUE_OPTION_LABEL) {
    const queued = await getSessionCommandCenter().spawn({ ...spawnInput, queueWhenFull: true });
    if (queued.outcome === 'requires_choice') {
      return { ok: true, output: describeOverflowUnansweredFallback(shortName) };
    }
    return delegateTaskReceipt(queued, '你已选择排队，无需再次选择。', includeTaskIds);
  }

  const matchedReplace = replaceable.find((entry) => entry.label === answer)
    ?? (answer.startsWith(OVERFLOW_REPLACE_OPTION_PREFIX)
      ? replaceable.find((entry) => entry.task.shortName === answer.slice(OVERFLOW_REPLACE_OPTION_PREFIX.length).trim())
      : undefined);

  if (matchedReplace) {
    const center = getSessionCommandCenter();
    const { cancellation, replacement } = await center.replace(spawnInput, matchedReplace.task.id);
    if (cancellation.outcome !== 'resolved' || !replacement || replacement.outcome === 'requires_choice') {
      return { ok: true, output: describeOverflowUnansweredFallback(shortName) };
    }
    const deadline = Date.now() + CANCELLATION_TIMEOUTS.ROUTE_SETTLE_WAIT;
    let stopped = center.list(sessionId).find((task) => task.id === cancellation.task.id)?.status === 'cancelled';
    while (!stopped && !abortSignal?.aborted && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, CANCELLATION_TIMEOUTS.ROUTE_SETTLE_POLL));
      stopped = center.list(sessionId).find((task) => task.id === cancellation.task.id)?.status === 'cancelled';
    }
    const cancellationReceipt = `${stopped ? '已停止' : '已请求停止'}「${cancellation.task.shortName}」。这是你刚才选择的替换，无需恢复原任务。`;
    const current = center.list(sessionId).find((task) => task.id === replacement.task.id);
    const receipt = delegateTaskReceipt(current?.status === 'running'
      ? { outcome: 'started', task: current }
      : replacement, cancellationReceipt, includeTaskIds);
    if (receipt.ok) receipt.meta = { ...receipt.meta, sessionTaskReplacement: { shortName: cancellation.task.shortName, stopped } };
    return receipt;
  }

  return { ok: true, output: describeOverflowUnansweredFallback(shortName) };
}

export async function executeSteerTask(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string>> {
  const denied = await permit(steerTaskSchema.name, args, canUseTool);
  if (denied) return denied;
  const session = requireSession(ctx);
  if (typeof session !== 'string') return session;
  const instruction = stringArg(args, 'instruction');
  if (!instruction) return { ok: false, error: 'instruction is required', code: 'INVALID_ARGS' };
  const result = await getSessionCommandCenter().steer(session, stringArg(args, 'target') || undefined, instruction);
  if (result.outcome !== 'resolved') return { ok: true, output: describeReferenceFailure(result, '转向', session) };
  return { ok: true, output: `已把新要求投递给「${result.task.shortName}」；它的完成状态仍以后续终态回流为准。` };
}

export async function executeCancelTask(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string>> {
  const denied = await permit(cancelTaskSchema.name, args, canUseTool);
  if (denied) return denied;
  const session = requireSession(ctx);
  if (typeof session !== 'string') return session;
  const result = await getSessionCommandCenter().cancel(session, stringArg(args, 'target') || undefined);
  if (result.outcome !== 'resolved') return { ok: true, output: describeReferenceFailure(result, '取消', session) };
  const verb = result.task.status === 'cancelled' ? '已取消' : '正在取消';
  return { ok: true, output: `${verb}「${result.task.shortName}」；只有终态回流后才能声称它已经停稳。` };
}

export async function executeTaskStatus(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string>> {
  const denied = await permit(taskStatusSchema.name, args, canUseTool);
  if (denied) return denied;
  const session = requireSession(ctx);
  if (typeof session !== 'string') return session;
  const tasks = getSessionCommandCenter().list(session);
  const snapshot = getAgentTreeSnapshot({ sessionId: session });
  const backgroundSubagents = snapshot.nodes.filter((node) => node.background);
  if (tasks.length === 0 && backgroundSubagents.length === 0) {
    return { ok: true, output: '当前会话还没有后台任务。' };
  }
  // 序号口径必须与 resolve() 一致：只有活跃任务编号（cancel_task/steer 的 target 序号），已结束的不编号
  const activeIds = getSessionCommandCenter().active(session).map((task) => task.id);
  const taskRows = tasks.map((task) => {
    // resultText 优先：240 字 summary 会截断「改走 Bash curl 审批」这类可执行提示（FB-577）
    const resultText = task.resultText ?? task.summary;
    const activeIndex = activeIds.indexOf(task.id);
    const label = activeIndex >= 0 ? `${activeIndex + 1}.` : '-';
    return `${label} ${task.shortName}：${sessionTaskStatusLabel(task.status)}${resultText ? `：${resultText}` : ''}`;
  });
  return {
    ok: true,
    output: [...taskRows, ...formatBackgroundSubagentRows(backgroundSubagents, snapshot.generatedAt, tasks.some((task) => task.status === 'running'))].join('\n'),
    meta: {
      ...sessionTaskMeta('status', tasks),
      ...(tasks.length ? { sessionTaskWorkspaceRoots: [...new Set(tasks.map((task) => task.workspaceScope.primaryRoot))] } : {}),
    },
  };
}

type CommandToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
) => Promise<ToolResult<string>>;

class Handler implements ToolHandler<Record<string, unknown>, string> {
  constructor(
    readonly schema: typeof delegateTaskSchema,
    private readonly executeFn: CommandToolExecutor,
  ) {}

  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return this.executeFn(args, ctx, canUseTool, onProgress);
  }
}

function moduleFor(
  schema: typeof delegateTaskSchema,
  executeFn: CommandToolExecutor,
): ToolModule<Record<string, unknown>, string> {
  return { schema, createHandler: () => new Handler(schema, executeFn) };
}

export const delegateTaskModule = moduleFor(delegateTaskSchema, (args, ctx, canUseTool, onProgress) =>
  executeDelegateTask(args, ctx, canUseTool, onProgress, true));
export const steerTaskModule = moduleFor(steerTaskSchema, executeSteerTask);
export const cancelTaskModule = moduleFor(cancelTaskSchema, executeCancelTask);
export const taskStatusModule = moduleFor(taskStatusSchema, executeTaskStatus);
