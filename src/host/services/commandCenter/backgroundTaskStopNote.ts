import type { Message, MessageMetadata } from '../../../shared/contract';
import type { SystemEventMessageMetadata } from '../../../shared/contract/systemEventRegistry';

/** 「」里名字的长度上限（按码点数）：超过才截断，且只在词边界下刀。 */
const STOP_NOTE_LABEL_MAX_CODE_POINTS = 24;

function isAsciiAlnum(char: string): boolean {
  return /[A-Za-z0-9]/.test(char);
}

/**
 * 停止行标题的显示规则：用完整标题；超长时在最后一个空白/中文边界前截断并加「…」，
 * 绝不在 [A-Za-z0-9] 连续段（英文单词）内部切断（「抓gui」/「抓取do」这类半截词的治理，
 * 两个调用方——指挥台投影与后台子代理——都经 recordBackgroundTaskStopNote 受益）。
 * 整段一个超长英文单词时退回硬截断：宁可贵在长，不能给出空名字。
 */
function buildStopNoteLabel(title: string): string {
  const trimmed = title.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= STOP_NOTE_LABEL_MAX_CODE_POINTS) return trimmed;
  let cut = STOP_NOTE_LABEL_MAX_CODE_POINTS;
  while (cut > 0 && isAsciiAlnum(chars[cut - 1]) && isAsciiAlnum(chars[cut])) cut -= 1;
  if (cut === 0) cut = STOP_NOTE_LABEL_MAX_CODE_POINTS;
  return `${chars.slice(0, cut).join('').trimEnd()}…`;
}

/** One delivery channel for early background stops: independent of assistant aggregation and wake turns. */
export async function recordBackgroundTaskStopNote(
  sessionId: string,
  title: string,
  content: string,
  detail: NonNullable<MessageMetadata['backgroundTaskStopped']>,
): Promise<void> {
  const [{ getSessionManager }, { getTaskManager }] = await Promise.all([
    import('../infra/sessionManager'), import('../../task/TaskManager'),
  ]);
  const message: Message = {
    id: `background-task-stopped-${detail.taskId}`,
    role: 'system',
    content: `「${buildStopNoteLabel(title)}」：${content}`,
    timestamp: Date.now(),
    metadata: { backgroundTaskStopped: detail } satisfies SystemEventMessageMetadata,
  };
  await getSessionManager().addMessageToSession(sessionId, message);
  getTaskManager().emitAgentEventForSession(sessionId, { type: 'message', data: message });
}
