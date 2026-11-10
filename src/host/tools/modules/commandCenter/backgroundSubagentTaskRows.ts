import type { AgentTreeNode } from '../../../../shared/contract/agentTree';
import { composeSessionCommandTaskResultText } from '../../../../shared/constants/sessionCommandCenter';

const BACKGROUND_SUBAGENT_TITLE_MAX_CHARS = 30;

function shortTitle(title: string | undefined): string {
  const normalized = title?.replace(/\s+/g, ' ').trim();
  if (!normalized) return '后台任务';
  const chars = Array.from(normalized);
  if (chars.length <= BACKGROUND_SUBAGENT_TITLE_MAX_CHARS) return normalized;
  return `${chars.slice(0, BACKGROUND_SUBAGENT_TITLE_MAX_CHARS - 1).join('')}…`;
}

export function formatBackgroundSubagentRows(
  nodes: AgentTreeNode[],
  startIndex: number,
  now: number,
  hasRunningCommandTasks: boolean,
): string[] {
  const rows = nodes.map((node, index) => {
    const name = node.displayName || (node.role !== 'background' && node.role !== 'agent' ? node.role : undefined)
      || shortTitle(node.task);
    const detail = composeSessionCommandTaskResultText(node.progress);
    const duration = node.createdAt === undefined ? 'unknown'
      : `${Math.max(0, Math.round(((node.completedAt ?? now) - node.createdAt) / 1000))} s`;
    return `${startIndex + index + 1}. ${name} [${node.status}] id=${node.id} duration=${duration}`
      + (detail ? `：${detail}` : '');
  });
  if (hasRunningCommandTasks || nodes.some((node) => node.status === 'running' || node.status === 'running-recovered' || node.status === 'unknown')) {
    rows.push('No remaining-time data exists. Do not estimate an ETA. Use only this fresh status read; finished helpers must never be described as running.');
  }
  return rows;
}
