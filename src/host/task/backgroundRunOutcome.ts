// ============================================================================
// 后台助手的结构化结局（N-FIX-DELEGATE-FAIL-CARD-RAW-DETAILS-AND-DONE-STATUS）
// 助手最终回复的第一行是一条 JSON 标记：status = done | partial | failed，可带一句 reason。
// host 在读最终回复的地方解析并剥掉它：标记绝不进用户可见文字，也不进给父模型的任务结果。
// 没有标记 = 不下结论，沿用原判决；绝不因为「没写标记」默认成完成，也不从措辞里猜。
// ============================================================================

import type { Message } from '../../shared/contract';
import type { TaskOutcome } from '../../shared/contract/backgroundTask';
import {
  formatSessionTaskDeliveryFailure,
  formatSessionTaskOutcomeNotDone,
  formatSessionTaskUserDenied,
  type SessionTaskResultStatusWordLocale,
} from '../../shared/constants/sessionCommandCenter';
import { describeFailedCommand, getTaskDeliveryFailure } from './taskDeliveryVerdict';

const OUTCOME_MARKER = '__NEO_TASK_OUTCOME__';
const OUTCOME_REASON_MAX_CHARS = 300;

export const AUXILIARY_RUN_SYSTEM_CONTEXT = [
  '你已经在一个独立后台任务槽里，必须亲自执行这件任务。',
  '禁止调用、搜索或建议 Task、TaskManager、spawn_agent、AgentSpawn、delegate_task、steer_task、cancel_task、task_status 等任务拆分或指挥台工具；上层已经完成任务拆分。',
  'AskUserQuestion 是已经加载的核心工具。用户要求它时，第一步直接调用；不得先用 ToolSearch 查它或任何任务拆分工具，也不要把工具名或 JSON 当文字输出。',
  `收尾要求：你最后一条回复的第一行必须是结局标记 ${OUTCOME_MARKER}{"status":"done|partial|failed","reason":"一句大白话原因"}，下一行起才是写给用户的说明。`,
  'status：done = 交代的事全部做成；partial = 只做成一部分；failed = 没做成（文件不存在、命令失败、缺权限等）。reason 不含命令、路径、错误码。写完回复不等于任务完成，没做成就如实写 failed。',
].join('\n');

const OUTCOME_STATUSES = new Set(['done', 'partial', 'failed']);

/** 剥掉含标记的行；能读出结局时一并返回。标记只认第一行，别处出现的标记行只剥不认。 */
function extractTaskOutcome(text: string | undefined): { text: string; outcome?: TaskOutcome } {
  const source = text?.trim() ?? '';
  if (!source.includes(OUTCOME_MARKER)) return { text: source };
  const lines = source.split('\n');
  let outcome: TaskOutcome | undefined;
  const first = lines[0]?.trim() ?? '';
  if (first.startsWith(OUTCOME_MARKER)) {
    try {
      const parsed = JSON.parse(first.slice(OUTCOME_MARKER.length)) as { status?: unknown; reason?: unknown };
      if (typeof parsed.status === 'string' && OUTCOME_STATUSES.has(parsed.status)) {
        const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, OUTCOME_REASON_MAX_CHARS) : '';
        outcome = { status: parsed.status as TaskOutcome['status'], ...(reason ? { reason } : {}) };
      }
    } catch {
      // 标记坏了：仍然剥掉，不当作任何结局。
    }
  }
  const kept = lines.filter((line) => !line.includes(OUTCOME_MARKER)).join('\n').trim();
  return { text: kept, ...(outcome ? { outcome } : {}) };
}

type BackgroundRunTerminal =
  | { type: 'task_cancelled'; data: { detail: string } }
  | { type: 'task_error'; data: { error: string; rawDetail?: string; outcome?: TaskOutcome } }
  | { type: 'task_completed'; data: { conclusion?: string; outcome?: TaskOutcome } };

/**
 * 后台助手跑完后的终态事件。error / conclusion 是折叠面的那一句；命令行、报错原文、助手自己的说明
 * 放 rawDetail，只在展开详情里出现。
 */
export function resolveBackgroundRunTerminal(input: {
  messages: readonly Message[];
  finalText: string | undefined;
  artifactCount: number;
  workingDirectory: string | undefined;
  locale: SessionTaskResultStatusWordLocale;
}): BackgroundRunTerminal {
  const { messages, locale } = input;
  const { text, outcome } = extractTaskOutcome(input.finalText);
  const deliveryFailure = getTaskDeliveryFailure(messages, input.artifactCount);
  if (deliveryFailure === 'user_denied') return { type: 'task_cancelled', data: { detail: formatSessionTaskUserDenied(locale) } };
  const reportedNotDone = outcome && outcome.status !== 'done' ? outcome.status : undefined;
  if (!deliveryFailure && !reportedNotDone) {
    return { type: 'task_completed', data: { conclusion: text || undefined, ...(outcome ? { outcome } : {}) } };
  }
  if (deliveryFailure === 'command_failed' || reportedNotDone) {
    const command = describeFailedCommand(messages, input.workingDirectory, locale, reportedNotDone !== undefined);
    const rawDetail = [command, outcome?.reason, text].filter(Boolean).join('\n\n');
    return {
      type: 'task_error',
      data: {
        error: formatSessionTaskOutcomeNotDone(locale, reportedNotDone ?? 'failed'),
        ...(rawDetail ? { rawDetail } : {}),
        ...(outcome ? { outcome } : {}),
      },
    };
  }
  return {
    type: 'task_error',
    data: { error: formatSessionTaskDeliveryFailure(deliveryFailure, locale) || text || 'Task delivery failed.' },
  };
}
