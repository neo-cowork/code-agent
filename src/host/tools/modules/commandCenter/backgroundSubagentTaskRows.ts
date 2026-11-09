import type { BackgroundSubagentHandle } from '../../../agent/backgroundSubagentRegistry';
import { composeSessionCommandTaskResultText } from '../../../../shared/constants/sessionCommandCenter';

const BACKGROUND_SUBAGENT_TITLE_MAX_CHARS = 30;

function shortTitle(title: string | undefined): string {
  const normalized = title?.replace(/\s+/g, ' ').trim();
  if (!normalized) return '后台任务';
  const chars = Array.from(normalized);
  if (chars.length <= BACKGROUND_SUBAGENT_TITLE_MAX_CHARS) return normalized;
  return `${chars.slice(0, BACKGROUND_SUBAGENT_TITLE_MAX_CHARS - 1).join('')}…`;
}

function resultOrError(handle: BackgroundSubagentHandle): string | undefined {
  const detail = handle.status === 'failed'
    ? handle.error ?? handle.result?.output
    : handle.result?.output ?? handle.error;
  return composeSessionCommandTaskResultText(detail);
}

export function formatBackgroundSubagentRows(
  handles: BackgroundSubagentHandle[],
  startIndex: number,
): string[] {
  return handles.map((handle, index) => {
    const detail = resultOrError(handle);
    return `${startIndex + index + 1}. ${shortTitle(handle.title)} [${handle.status}] id=${handle.agentId}`
      + (detail ? `：${detail}` : '');
  });
}
