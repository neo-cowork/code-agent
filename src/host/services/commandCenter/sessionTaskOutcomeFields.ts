// 后台任务终态事件里的结构化结局字段（助手自报的 outcome + 只进展开详情的 rawDetail）。
import type { TaskOutcome } from '../../../shared/contract/backgroundTask';
import { composeSessionCommandTaskDisplayText } from '../../../shared/constants/sessionCommandCenter';
import { composeTaskResultForModel } from './taskResultHandback';

/** task_completed / task_error 事件数据 → 任务上要记的结局与原始详情。形状不对一律当没有。 */
export function readOutcomeFields(event: object | undefined): {
  outcome?: TaskOutcome;
  rawDetail?: string;
} {
  const data = event as { outcome?: unknown; rawDetail?: unknown } | undefined;
  const raw = data?.outcome as { status?: unknown; reason?: unknown } | undefined;
  const status = raw?.status;
  const outcome: TaskOutcome | undefined = status === 'done' || status === 'partial' || status === 'failed'
    ? { status, ...(typeof raw?.reason === 'string' && raw.reason ? { reason: raw.reason } : {}) }
    : undefined;
  const rawDetail = typeof data?.rawDetail === 'string' && data.rawDetail.trim() ? data.rawDetail : undefined;
  return { ...(outcome ? { outcome } : {}), ...(rawDetail ? { rawDetail } : {}) };
}

/** 折叠那一句 + 原始详情。折叠面（summary / failure.message）只用 detail；给模型的结果文本与成员页展开详情带上 rawDetail。 */
function withRawDetail(task: { rawDetail?: string }, detail: string | undefined): string | undefined {
  return task.rawDetail ? `${detail ?? ''}\n\n${task.rawDetail}`.trim() : detail;
}

export function composeModelResultText(task: { id: string; sessionId: string; rawDetail?: string }, detail: string | undefined) {
  return composeTaskResultForModel(task, withRawDetail(task, detail));
}

export function composeExpandedDetailText(task: { rawDetail?: string; detail?: string }) {
  return composeSessionCommandTaskDisplayText(withRawDetail(task, task.detail));
}
