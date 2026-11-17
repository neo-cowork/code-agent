// 提醒改 / 删的批准卡补充信息：只给卡片看，不改即将派发的参数。
// 和日历补全放在同一次审批里：工具体内再拿一份不同的参数会再弹一张卡。
// 查不到（未授权、桥不通、没有这条）就什么都不补，卡片照常出，只是没有标题。
// 模型已经带来的 title 优先于查到的标题。删除卡走通用预览，标题和时间补进那份 preview。
import type { ConfirmationPreview } from '../../../../shared/contract/confirmation';
import { getConnectorRegistry } from '../../../connectors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatTimestamp(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(value).toLocaleString('zh-CN');
}

export async function remindersApprovalDetails(
  toolName: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (toolName !== 'reminders_update' && toolName !== 'reminders_delete') return {};
  const list = typeof params.list === 'string' ? params.list.trim() : '';
  const reminderId = typeof params.reminder_id === 'string' ? params.reminder_id.trim() : '';
  if (!list || !reminderId) return {};
  const connector = getConnectorRegistry().get('reminders');
  if (!connector) return {};
  try {
    const { data } = await connector.execute('get_reminder', { list, reminder_id: reminderId });
    if (!isRecord(data)) return {};
    const extra: Record<string, unknown> = {};
    const modelTitle = typeof params.title === 'string' ? params.title.trim() : '';
    const lookedUpTitle = typeof data.title === 'string' ? data.title.trim() : '';
    if (!modelTitle && lookedUpTitle) extra.title = lookedUpTitle;
    if (
      toolName === 'reminders_delete'
      && !Object.hasOwn(params, 'remind_at_ms')
      && typeof data.remindAtMs === 'number'
      && Number.isFinite(data.remindAtMs)
    ) {
      extra.remind_at_ms = data.remindAtMs;
    }
    return extra;
  } catch {
    // 查不到就少一行标题，不另弹错误卡，也不改派发参数。
    return {};
  }
}

/** 删除提醒走通用卡，标题和时间只补进 ConfirmationPreview，不改派发参数。 */
export function applyRemindersDeletePreview(
  preview: ConfirmationPreview | undefined,
  extra: Record<string, unknown>,
): void {
  if (preview?.type !== 'generic') return;
  const lines = (preview.diff ?? preview.summary).split('\n');
  const title = typeof extra.title === 'string' ? extra.title.trim() : '';
  if (title && !lines.some((line) => line.startsWith('Title: '))) {
    const listAt = lines.findIndex((line) => line.startsWith('List: '));
    lines.splice(listAt >= 0 ? listAt + 1 : Math.min(1, lines.length), 0, `Title: ${title}`);
  }
  const time = formatTimestamp(extra.remind_at_ms);
  if (time && !lines.some((line) => line.startsWith('Remind At: '))) lines.push(`Remind At: ${time}`);
  preview.diff = lines.join('\n');
}
