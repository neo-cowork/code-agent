// ============================================================================
// task_status 同 turn 去重（N-FIX-BGTASK-STATUS-POLL-TRIPLE-CARDS-REST1）
//
// 派活后模型常在几秒内连查 2-3 次 task_status，全量回答每次都重画一张「进行中」
// 卡片。这里按会话记上次全量回答的签名与下发时的 turnId：
//   - 签名 = 任务 id/短名/状态/结果文本 + 子代理 id/状态/详情；已用时（每查必变）
//     与 snapshot.generatedAt 不进签名，否则去重永远不命中。
//   - 同一 turn 内签名未变且无终态 → 回短提示（见 TASK_STATUS_UNCHANGED_HINT），
//     meta 仍由调用方原样带上，卡片文案与 foldSessionTaskStatus 折叠不受影响。
//   - 签名变化、换了 turn（用户在新 turn 里再问）、缺 turnId 或出现终态 → 照旧
//     全量回答并覆盖记录；终态后「完成会自动通知你」的承诺已兑现，模型需要读到
//     全量结果文本，不进去重。
// 记录只存几十字节级签名串；条目按 TASK_STATUS_DEDUPE_MAX_SESSIONS 封顶，
// 会话里已无可跟踪的任务/子代理时由调用方顺路清掉。
// ============================================================================

import type { AgentTreeNode } from '../../../../shared/contract/agentTree';
import type { SessionCommandTask } from '../../../services/commandCenter/sessionCommandCenter';
import {
  composeSessionCommandTaskResultText,
  TASK_STATUS_DEDUPE_MAX_SESSIONS,
  TASK_STATUS_HINT_TITLE_MAX_CHARS,
  TASK_STATUS_UNCHANGED_HINT,
} from '../../../../shared/constants/sessionCommandCenter';
import { sessionTaskStatusLabel } from '../../../../shared/i18n/sessionTaskStatus';

interface TaskStatusAnswerRecord {
  turnId: string | undefined;
  signature: string;
}

const recordsBySession = new Map<string, TaskStatusAnswerRecord>();

/** 与指挥台服务侧 TERMINAL 同口径（killed 只出现在子代理节点上），保持内联避免新增散落常量。 */
function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'killed';
}

function hasTerminalState(tasks: SessionCommandTask[], subagents: AgentTreeNode[]): boolean {
  return tasks.some((task) => isTerminalStatus(task.status))
    || subagents.some((node) => isTerminalStatus(node.status));
}

function signatureOf(tasks: SessionCommandTask[], subagents: AgentTreeNode[]): string {
  return JSON.stringify({
    tasks: tasks.map((task) => ({
      id: task.id,
      shortName: task.shortName,
      status: task.status,
      // 与全量输出行同口径：resultText 优先，缺省回落 240 字 summary
      resultText: task.resultText ?? task.summary ?? '',
    })),
    subagents: subagents.map((node) => ({
      id: node.id,
      status: node.status,
      detail: composeSessionCommandTaskResultText(node.progress) ?? '',
    })),
  });
}

/** 同一 turn、签名未变且无终态时才允许用短提示替代全量回答。 */
export function shouldReturnTaskStatusUnchangedHint(
  sessionId: string,
  turnId: string | undefined,
  tasks: SessionCommandTask[],
  subagents: AgentTreeNode[],
): boolean {
  if (!turnId) return false;
  const record = recordsBySession.get(sessionId);
  if (record?.turnId !== turnId) return false;
  if (hasTerminalState(tasks, subagents)) return false;
  return record.signature === signatureOf(tasks, subagents);
}

/**
 * 短提示：固定句 + 与全量同口径的标识符行（活跃任务序号供 cancel/steer 用、
 * 子代理（Agent ID: …）后缀供 collect 用）；不重复结果文本与已用时。
 */
export function taskStatusUnchangedHint(tasks: SessionCommandTask[], subagents: AgentTreeNode[]): string {
  const activeIds = tasks.filter((task) => !isTerminalStatus(task.status)).map((task) => task.id);
  // 行名与 backgroundSubagentTaskRows 全量行同源：displayName → 角色（background/agent 除外）→ 任务标题
  const subagentRows = subagents.map((node) => {
    const rawName = node.displayName || (node.role !== 'background' && node.role !== 'agent' ? node.role : undefined)
      || node.task || '后台任务';
    // 截断口径与 backgroundSubagentTaskRows.shortTitle 一致（超宽加省略号），提示行与全量行不出现两个名字
    const nameChars = Array.from(rawName);
    const name = nameChars.length <= TASK_STATUS_HINT_TITLE_MAX_CHARS
      ? rawName
      : `${nameChars.slice(0, TASK_STATUS_HINT_TITLE_MAX_CHARS - 1).join('')}…`;
    return `- ${name} ：${sessionTaskStatusLabel(node.status)}（Agent ID: ${node.id}）`;
  });
  const taskRows = tasks.map((task) => {
    const activeIndex = activeIds.indexOf(task.id);
    const label = activeIndex >= 0 ? `${activeIndex + 1}.` : '-';
    return `${label} ${task.shortName}：${sessionTaskStatusLabel(task.status)}`;
  });
  const rows = [...taskRows, ...subagentRows];
  return rows.length > 0 ? `${TASK_STATUS_UNCHANGED_HINT}\n${rows.join('\n')}` : TASK_STATUS_UNCHANGED_HINT;
}

export function recordTaskStatusAnswer(
  sessionId: string,
  turnId: string | undefined,
  tasks: SessionCommandTask[],
  subagents: AgentTreeNode[],
): void {
  while (recordsBySession.size >= TASK_STATUS_DEDUPE_MAX_SESSIONS) {
    const oldest = recordsBySession.keys().next().value;
    if (oldest === undefined) break;
    recordsBySession.delete(oldest);
  }
  recordsBySession.set(sessionId, { turnId, signature: signatureOf(tasks, subagents) });
}

/** 会话里已无可跟踪的任务/子代理时清掉旧记录（「finished 会话不占位」的落地钩子）。 */
export function dropTaskStatusRecordIfIdle(
  sessionId: string,
  tasks: SessionCommandTask[],
  subagents: AgentTreeNode[],
): void {
  if (tasks.length === 0 && subagents.length === 0) recordsBySession.delete(sessionId);
}
