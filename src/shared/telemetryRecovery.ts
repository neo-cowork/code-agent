// 「由运行记录还原的用户消息」的共享口径：宿主写入标记、模型上下文补回免责声明、
// 界面剥掉历史行里已拼进正文的旧前缀，三处共用同一段文本。
import type { Message } from './contract';

/** 只给模型看的提示：重建内容可能被脱敏缩写，不能当精确目标。 */
const TELEMETRY_RECOVERY_NOTICE =
  '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字和敏感值可能已被缩写或替换，不要将它们当作可直接执行的精确文件或命令目标。';

const NOTICE_PREFIX = `${TELEMETRY_RECOVERY_NOTICE}\n\n`;

/** 旧版本已把免责声明拼进正文落库的历史行。 */
function hasLegacyTelemetryRecoveryPrefix(content: string): boolean {
  return content.startsWith(NOTICE_PREFIX);
}

/** 展示用：去掉旧前缀，其余原样返回。 */
export function stripTelemetryRecoveryNotice(content: string): string {
  return hasLegacyTelemetryRecoveryPrefix(content) ? content.slice(NOTICE_PREFIX.length) : content;
}

/** 新标记或旧前缀任一成立即视为「由运行记录还原」。 */
export function isTelemetryRecoveredMessage(
  message: Pick<Message, 'role' | 'content' | 'metadata'>,
): boolean {
  if (message.role !== 'user') return false;
  return message.metadata?.telemetryRecovered === true
    || (typeof message.content === 'string' && hasLegacyTelemetryRecoveryPrefix(message.content));
}

function withTelemetryRecoveryNotice(content: string): string {
  return hasLegacyTelemetryRecoveryPrefix(content) ? content : `${NOTICE_PREFIX}${content}`;
}

/** 装配入口：仅对带标记的 user 消息补回声明，其余消息原对象返回（字节不变）。 */
export function withTelemetryRecoveryNoticeForModel(messages: readonly Message[]): Message[] {
  if (!messages.some((m) => m.role === 'user' && m.metadata?.telemetryRecovered === true)) {
    return messages as Message[];
  }
  return messages.map((m) =>
    m.role === 'user' && m.metadata?.telemetryRecovered === true
      ? { ...m, content: withTelemetryRecoveryNotice(m.content) }
      : m);
}
