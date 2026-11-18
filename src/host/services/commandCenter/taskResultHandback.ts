// 后台任务结果交给前台模型的文本：预算内整段送达；超预算 = 开头 + 存档指针（模型用
// read_tool_result_archive 读全文）。存档失败不静默：warn 可区分原因并保留旧的截断标记。
import { createLogger } from '../infra/logger';
import { buildSpillNotice, spillToolResultArchive } from '../../utils/toolResultSpill';
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
  return `${head}${buildSpillNotice(archive.archiveRef)}\n${handbackSentence(chars.length)}`;
}

function handbackSentence(total: number): string {
  return `以上只是结果的开头（共 ${total} 字），完整结果已存档。如果用户需要全部内容，回答前先用 read_tool_result_archive 读取（artifact_id 填上面 archive= 后面的值）；不要把存档路径或编号原样告诉用户。`;
}

const HANDBACK_TAIL = /\n\[[^\n]*\]\n以上只是结果的开头（共 (\d+) 字），完整结果已存档。[^\n]*$/;

/** 卡片摘要：只剥掉末尾的存档提示（保留换行与其余正文），超 1500 封顶，total 报真实总长。 */
export function clampTaskResultCardSummary(text: string): string {
  const tail = HANDBACK_TAIL.exec(text);
  const body = tail ? text.slice(0, tail.index) : text;
  const prior = /…\(truncated, (\d+) chars total\)$/.exec(body);
  const total = tail ? Number(tail[1]) : prior ? Number(prior[1]) : Array.from(body).length;
  const chars = Array.from(body);
  if (chars.length <= SESSION_COMMAND_TASK_RESULT_CARD_MAX_CHARS && !tail) return body;
  return `${chars.slice(0, SESSION_COMMAND_TASK_RESULT_CARD_MAX_CHARS).join('')}…(truncated, ${total} chars total)`;
}
