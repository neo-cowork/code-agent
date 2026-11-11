import { SUBAGENT_COMPLETION_NOTIFICATIONS } from '../../shared/constants';
import { buildSpillNotice, spillToolResultArchive, type ToolResultArchiveRef } from '../utils/toolResultSpill';
import type { AgentFailureCode } from '../../shared/contract/agentFailure';

export type SubagentCompletionStatus = 'completed' | 'failed' | 'cancelled' | 'killed' | 'stalled';
export type SubagentCompletionKind = 'user_visible' | 'internal' | 'shell';

export interface SubagentCompletionScope {
  sessionId?: string;
  runId?: string;
  treeId?: string;
}

export interface SubagentCompletionRecord extends SubagentCompletionScope {
  agentId: string;
  title: string;
  role?: string;
  kind: SubagentCompletionKind;
  status: SubagentCompletionStatus;
  summary: string;
  durationMs?: number;
  failureCode?: AgentFailureCode;
  archiveRef?: ToolResultArchiveRef;
  content: string;
  createdAt: number;
  dedupeKey: string;
}

export interface BuildSubagentCompletionRecordInput extends SubagentCompletionScope {
  agentId: string;
  title?: string;
  role?: string;
  kind?: SubagentCompletionKind;
  status: SubagentCompletionStatus;
  output?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  failureCode?: AgentFailureCode;
  toolsUsed?: string[];
  /** 已发生的工具调用次数。没有 toolsUsed 名单时用它填 stats.tool_calls。 */
  toolCallCount?: number;
  iterations?: number;
  cost?: number;
  /** 最近一条助手正文或工具步标签。缺省则 payload 不带 last_progress。 */
  lastProgress?: string;
  /** 声明了但未装配的工具（N-SUBAGENT-ZEROTOOLS 返修 Important 2：后台完成通知透传给父模型）。 */
  missingTools?: string[];
  /** 覆盖 payload.next_action 默认文案。stall 提醒指向当前状态而非「最终结果」（run 未收尾）。 */
  nextAction?: string;
}

function statusLabel(status: SubagentCompletionStatus): string {
  if (status === 'completed') return 'completed';
  // stalled 是非终态提醒（N-WF-STALL-NOTICE）：run 还在跑，不许渲染成失败收尾。
  if (status === 'stalled') return 'stalled (no progress)';
  return `ended with ${status}`;
}

function scopeDedupePrefix(input: SubagentCompletionScope): string {
  return `${input.sessionId ?? 'global'}:${input.runId ?? 'session'}:${input.treeId ?? 'default'}`;
}

/** wake：通知是新一轮父会话的全部输入；inline：通知追加在父 run 正在处理的工具结果里。 */
export type SubagentCompletionDelivery = 'wake' | 'inline';

function buildCompletionAckInstruction(
  kind: SubagentCompletionKind,
  title: string,
  delivery: SubagentCompletionDelivery = 'inline',
): string {
  const namingRule = `提到子代理时，只能使用通知中的标题「${title}」，禁止使用 [agent]、[worker]、agent 或 worker 等泛称。`;
  if (kind === 'user_visible') {
    const report = '用用户的语言写一份简明汇报，只写一遍，不要照抄通知原文；子代理改了文件且通知里有分支名时，写出分支名并说明需要合并才会生效；不要出现任务编号、工具名、信封标签或绝对路径。';
    if (delivery === 'wake') {
      return `回应要求：用户还没看到子代理的完整结果。本轮不要调用任何工具，直接${report}${namingRule}`;
    }
    return `回应要求：用户还没看到子代理的完整结果。先完成你当前正在做的任务，再向用户简要说明这个后台结果：${report}${namingRule}`;
  }
  if (kind === 'shell') {
    return `回应要求：用简短、非技术化的话向用户说明「${title}」的执行结果和下一步，不要只罗列退出码、日志或命令细节。${namingRule}`;
  }
  return `回应要求：结果只在内部上下文中。先完成必要的后续动作；没有后续动作时，不要回复用户。${namingRule}`;
}

function buildOutputSummary(input: BuildSubagentCompletionRecordInput): {
  summary: string;
  archiveRef?: ToolResultArchiveRef;
} {
  const raw = input.output || input.error || '';
  if (!raw) {
    return { summary: input.status === 'completed' ? 'No output was returned.' : 'No error output was returned.' };
  }

  if (raw.length <= SUBAGENT_COMPLETION_NOTIFICATIONS.INLINE_OUTPUT_LIMIT) {
    return { summary: raw };
  }

  const archive = spillToolResultArchive({
    content: raw,
    toolName: 'subagent_completion',
    sessionId: input.sessionId,
    toolCallId: input.agentId,
    reason: 'subagent-completion-notification',
  });
  if (!archive) {
    return {
      summary: `Output exceeded inline reminder budget. Use collect_agent("${input.agentId}") to fetch the final result.`,
    };
  }

  return {
    archiveRef: archive.archiveRef,
    summary:
      `Output exceeded inline reminder budget and was archived as ${archive.archiveRef.artifactId}. ` +
      `Use collect_agent("${input.agentId}") for the final result or read_tool_result_archive with that artifact_id for paged output.` +
      buildSpillNotice(archive.archiveRef),
  };
}

export function buildSubagentCompletionRecord(input: BuildSubagentCompletionRecordInput): SubagentCompletionRecord {
  const { summary, archiveRef } = buildOutputSummary(input);
  const title = input.title?.trim() || input.role?.trim() || input.agentId;
  const kind = input.kind ?? 'internal';
  const durationMs = typeof input.startedAt === 'number' && typeof input.finishedAt === 'number'
    ? Math.max(0, input.finishedAt - input.startedAt)
    : undefined;
  const payload = {
    agent_id: input.agentId,
    title,
    role: input.role,
    completion_kind: kind,
    status: input.status,
    summary,
    ...(input.lastProgress ? { last_progress: input.lastProgress } : {}),
    stats: {
      tool_calls: input.toolCallCount ?? input.toolsUsed?.length ?? 0,
      iterations: input.iterations ?? 0,
      ...(input.cost !== undefined ? { cost: input.cost } : {}),
      duration_ms: durationMs,
    },
    failure_code: input.failureCode,
    ...(input.missingTools && input.missingTools.length > 0
      ? { missing_tools: input.missingTools }
      : {}),
    archive: archiveRef
      ? {
          artifact_id: archiveRef.artifactId,
          bytes: archiveRef.bytes,
          sha256: archiveRef.sha256.slice(0, 12),
        }
      : undefined,
    next_action: input.nextAction ?? `Use collect_agent("${input.agentId}") to inspect the final result.`,
  };
  const ackInstruction = buildCompletionAckInstruction(kind, title);
  const content = `<subagent_notification>\n${JSON.stringify(payload, null, 2)}\n<completion_ack_instruction>\n${ackInstruction}\n</completion_ack_instruction>\n</subagent_notification>`;
  return {
    agentId: input.agentId,
    title,
    role: input.role,
    kind,
    status: input.status,
    summary,
    durationMs,
    failureCode: input.failureCode,
    archiveRef,
    sessionId: input.sessionId,
    runId: input.runId,
    treeId: input.treeId,
    content,
    createdAt: Date.now(),
    dedupeKey: `${scopeDedupePrefix(input)}:${input.agentId}:${input.status}:${input.finishedAt ?? 'unknown'}`,
  };
}

/** 批标题：混入 stalled 记录时不许说 "completed"——那是终态词，stall 的 run 还在跑。 */
function batchTitle(records: readonly SubagentCompletionRecord[]): string {
  const stalled = records.filter((record) => record.status === 'stalled').length;
  if (stalled === 0) {
    return records.length === 1 ? '1 background task completed' : `${records.length} background tasks completed`;
  }
  if (stalled === records.length) {
    return records.length === 1
      ? '1 background task stalled (no progress)'
      : `${records.length} background tasks stalled (no progress)`;
  }
  return `${records.length} background task updates`;
}

const ACK_BLOCK = /<completion_ack_instruction>[\s\S]*?<\/completion_ack_instruction>/;

export function formatSystemReminderForCompletions(
  records: readonly SubagentCompletionRecord[],
  options: { delivery?: SubagentCompletionDelivery } = {},
): string {
  if (records.length === 0) return '';
  const title = batchTitle(records);
  const body = records
    .map((record) => {
      const role = record.role ? ` (${record.role})` : '';
      const duration = typeof record.durationMs === 'number' ? `, duration_ms=${record.durationMs}` : '';
      const title = record.title || record.role || record.agentId;
      // 记录里的回应要求是按「inline」构建的；唤醒轮整轮只有这条通知，换成唤醒版。
      const content = options.delivery === 'wake'
        ? record.content.replace(ACK_BLOCK, () => `<completion_ack_instruction>\n${buildCompletionAckInstruction(record.kind, title, 'wake')}\n</completion_ack_instruction>`)
        : record.content;
      return `- ${title}${role}: ${statusLabel(record.status)}${duration}\n${content}`;
    })
    .join('\n');
  return `<system-reminder>\n${title}\n${body}\n</system-reminder>`;
}
