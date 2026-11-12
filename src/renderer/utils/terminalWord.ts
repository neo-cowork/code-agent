// ============================================================================
// 终态词唯一解析器：任务面板 / 后台任务行 / 自动化中心都读这里，再去
// i18n/outcomeWords 取词。各面板不再各自从 status 推一套「已完成/已停止/失败」。
// ============================================================================

import type { OutcomeKey } from '../i18n/outcomeWords';
import type { RunUiState } from '../types/runWorkbench';
import { BACKGROUND_TASK_CANCELLED } from '@shared/constants';
import type { BackgroundSessionInfo } from '@shared/contract/sessionState';

/** 「已完成」是否被失败步骤推翻：全败 → failed-tool，部分败 → completed-with-warnings。前台 run 与后台行共用。 */
function resolveCompletedKey(steps: ToolStepOutcome | undefined): OutcomeKey {
  if (!steps || steps.failed === 0) return 'completed';
  return steps.failed >= steps.total ? 'failed-tool' : 'completed-with-warnings';
}

type ToolStepOutcome = NonNullable<RunUiState['toolStepOutcome']>;

/** 已加载会话消息里收尾工具步骤的失败数/总数（result.success===false 才算失败）；与 buildRunUiState 同口径。 */
export function countToolSteps(
  messages: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ result?: { success?: boolean } }> }>,
): ToolStepOutcome | undefined {
  let failed = 0;
  let total = 0;
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!call.result) continue;
      total += 1;
      if (call.result.success === false) failed += 1;
    }
  }
  return total > 0 ? { failed, total } : undefined;
}

/** 前台 run → 终态词键；活跃/等确认返回 null（没有终态可说），干净完成返回 'completed'。 */
export function resolveRunTerminalKey(
  run: Pick<RunUiState, 'status' | 'terminalReason' | 'toolStepOutcome'>,
): OutcomeKey | null {
  switch (run.status) {
    case 'cancelled':
      return run.terminalReason === 'idle_reaped' ? 'failed-idle-reaped' : 'cancelled-by-user';
    case 'blocked':
      return 'failed-unknown';
    case 'completed':
      return resolveCompletedKey(run.toolStepOutcome);
    default:
      return null;
  }
}

/** 后台任务行 → 终态词键；running 返回 null。前台会话已被停掉时（taskCancelled）以停止为准。 */
export function resolveBackgroundTerminalKey(
  session: Pick<BackgroundSessionInfo, 'status' | 'completionMessage'>,
  opts: { taskCancelled?: boolean; toolStepOutcome?: ToolStepOutcome } = {},
): OutcomeKey | null {
  const taskCancelled = opts.taskCancelled ?? false;
  if (session.completionMessage === BACKGROUND_TASK_CANCELLED || (taskCancelled && session.status === 'running')) {
    return 'cancelled-by-user';
  }
  if (session.status === 'failed') return 'failed-unknown';
  if (session.status === 'completed') return resolveCompletedKey(opts.toolStepOutcome);
  return null;
}
