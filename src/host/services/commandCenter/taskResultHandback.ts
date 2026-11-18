// 后台任务结果交给前台模型的文本：预算内整段送达；超预算 = 开头 + 存档指针（模型用
// read_tool_result_archive 读全文）。存档失败不静默：warn 可区分原因并保留旧的截断标记。
import { createLogger } from '../infra/logger';
import { buildSpillNotice, SPILL_NOTICE_MARKER, spillToolResultArchive } from '../../utils/toolResultSpill';
import {
  SESSION_COMMAND_TASK_RESULT_CARD_MAX_CHARS,
  SESSION_COMMAND_TASK_RESULT_MODEL_MAX_CHARS,
  composeSessionCommandTaskResultText,
  normalizeSessionCommandTaskResultText,
} from '../../../shared/constants/sessionCommandCenter';

const logger = createLogger('TaskResultHandback');

export function composeTaskResultForModel(
  task: { id: string; sessionId: string },
  detail: string | undefined,
): string | undefined {
  const text = composeSessionCommandTaskResultText(detail);
  const normalized = normalizeSessionCommandTaskResultText(detail);
  if (!text || !normalized || !detail) return text;
  const chars = Array.from(normalized);
  if (chars.length <= SESSION_COMMAND_TASK_RESULT_MODEL_MAX_CHARS) return text;

  const archive = spillToolResultArchive({
    content: detail,
    toolName: 'background_task_result',
    sessionId: task.sessionId,
    toolCallId: task.id,
    reason: 'background-task-result',
  });
  if (!archive) {
    logger.warn('Background task result exceeded the model budget and could not be archived; kept truncated text', {
      taskId: task.id,
      reason: 'task_result_spill_failed',
      chars: chars.length,
    });
    return text;
  }
  const head = chars.slice(0, SESSION_COMMAND_TASK_RESULT_MODEL_MAX_CHARS).join('');
  return `${head}${buildSpillNotice(archive.archiveRef)}\n以上只是结果的开头，完整结果已存档。如果用户需要全部内容，回答前先用 read_tool_result_archive 读取（artifact_id 填上面 archive= 后面的值）；不要把存档路径或编号原样告诉用户。`;
}

/** 卡片摘要：去掉存档提示，保持历史口径（折叠空白，1500 封顶）。 */
export function clampTaskResultCardSummary(text: string): string {
  const cut = text.indexOf(`\n${SPILL_NOTICE_MARKER}`);
  const body = (cut >= 0 ? text.slice(0, cut) : text).replace(/\s+/g, ' ').trim();
  const chars = Array.from(body);
  if (chars.length <= SESSION_COMMAND_TASK_RESULT_CARD_MAX_CHARS) return body;
  return `${chars.slice(0, SESSION_COMMAND_TASK_RESULT_CARD_MAX_CHARS).join('')}…(truncated, ${chars.length} chars total)`;
}
