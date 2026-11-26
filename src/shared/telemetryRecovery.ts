// 「由运行记录还原的用户消息」的共享口径：宿主写入标记、模型上下文补回免责声明、
// 界面剥掉历史行里已拼进正文的旧前缀，三处共用同一段文本。
import type { Message } from './contract';

/** 旧版提示全文：只用于识别/剥掉已落库的历史行，不再发给模型。 */
const LEGACY_TELEMETRY_RECOVERY_NOTICE =
  '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字和敏感值可能已被缩写或替换，不要将它们当作可直接执行的精确文件或命令目标。';

/** 只给模型看的提示：用大白话交代还原来源，并规定对用户怎么说、不许全机搜索。 */
const TELEMETRY_RECOVERY_NOTICE =
  '【历史恢复提示】这条用户消息是根据 App 的运行记录还原的，措辞、路径和数字可能被缩短或写错，不要把缩短的路径当作确切目标。用户问起这条消息时，只对用户说「这条消息是根据运行记录还原的，路径可能不完整」，并请用户给出完整路径，或把文件直接发给你。不要为了找这个缩短的路径去搜索整台电脑或用户的个人文件夹。回复里不要出现 telemetry、重建、脱敏、home、shell、Glob 这些词，也不要提任何工具名。';

const NOTICE_PREFIX = `${TELEMETRY_RECOVERY_NOTICE}\n\n`;
const LEGACY_NOTICE_PREFIX = `${LEGACY_TELEMETRY_RECOVERY_NOTICE}\n\n`;

/** 旧版本已把免责声明拼进正文落库的历史行。 */
function hasLegacyTelemetryRecoveryPrefix(content: string): boolean {
  return content.startsWith(LEGACY_NOTICE_PREFIX) || content.startsWith(NOTICE_PREFIX);
}

/** 展示用：去掉旧前缀，其余原样返回。 */
export function stripTelemetryRecoveryNotice(content: string): string {
  if (content.startsWith(LEGACY_NOTICE_PREFIX)) return content.slice(LEGACY_NOTICE_PREFIX.length);
  if (content.startsWith(NOTICE_PREFIX)) return content.slice(NOTICE_PREFIX.length);
  return content;
}

/** 记忆摘要里被截断过的旧提示残留：完整前缀已剥不掉，只能按开头识别并丢弃。 */
export function isTelemetryRecoveryNoticeResidue(text: string): boolean {
  return text.trim().startsWith('【历史恢复提示】');
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
  if (content.startsWith(NOTICE_PREFIX)) return content;
  // 旧前缀行：换成新提示，模型请求里不再出现旧口径。
  if (content.startsWith(LEGACY_NOTICE_PREFIX)) return `${NOTICE_PREFIX}${content.slice(LEGACY_NOTICE_PREFIX.length)}`;
  return `${NOTICE_PREFIX}${content}`;
}

/** 装配入口：仅对「由运行记录还原」的 user 消息（新标记或旧前缀）补回声明，其余消息原对象返回（字节不变）。 */
export function withTelemetryRecoveryNoticeForModel(messages: readonly Message[]): Message[] {
  if (!messages.some(isTelemetryRecoveredMessage)) return messages as Message[];
  return messages.map((m) =>
    isTelemetryRecoveredMessage(m) ? { ...m, content: withTelemetryRecoveryNotice(m.content) } : m);
}
