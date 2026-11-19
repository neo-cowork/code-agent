// 提醒改 / 删的批准卡要显示的标题和时间：只给卡片看，不改工具参数。
// 必须在工具执行前那唯一一次审批里补上。更新只补模型未传的字段，并记在
// calendarApprovalSnapshotFields 上，确认修改时不会把查出来的旧值写回去。
// 删除始终以查到的标题和时间为准。找不到（或删除时任何查询失败）则抛出，调用方不弹卡。
import { getConnectorRegistry } from '../../../connectors';

const NOT_FOUND = /-1728|can['’]t get|\bnot found\b/i;
const NOT_FOUND_MESSAGE = 'No reminder matches that list and reminder_id. Call reminders list_reminders again and use the id it returns.';
const DELETE_LOOKUP_FAILED = 'Could not look up the reminder before delete, so nothing was changed. Call reminders list_reminders and try again.';

function reminderLookupNotFound(error: unknown): boolean {
  const record = (typeof error === 'object' && error !== null ? error : {}) as { stderr?: unknown };
  const text = [
    error instanceof Error ? error.message : String(error ?? ''),
    typeof record.stderr === 'string' ? record.stderr : '',
  ].join('\n');
  return NOT_FOUND.test(text);
}

export async function remindersApprovalDetails(
  toolName: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (toolName !== 'reminders_update' && toolName !== 'reminders_delete') return {};
  const connector = getConnectorRegistry().get('reminders');
  if (!connector) {
    if (toolName === 'reminders_delete') throw new Error(DELETE_LOOKUP_FAILED);
    return {};
  }
  try {
    const { data } = await connector.execute('get_reminder', params);
    const reminder = (data && typeof data === 'object' ? data : null) as { title?: unknown; remindAtMs?: unknown } | null;
    if (!reminder) throw new Error(NOT_FOUND_MESSAGE);
    const details: Record<string, unknown> = {
      ...(typeof reminder.title === 'string' && reminder.title ? { title: reminder.title } : {}),
      ...(typeof reminder.remindAtMs === 'number' ? { remind_at_ms: reminder.remindAtMs } : {}),
    };
    if (toolName === 'reminders_update') {
      for (const key of Object.keys(details)) {
        if (Object.hasOwn(params, key)) delete details[key];
      }
      const snapshotFields = Object.keys(details);
      if (snapshotFields.length > 0) details.calendarApprovalSnapshotFields = snapshotFields;
    }
    return details;
  } catch (error) {
    if (error instanceof Error && (error.message === NOT_FOUND_MESSAGE || error.message === DELETE_LOOKUP_FAILED)) throw error;
    const notFound = reminderLookupNotFound(error);
    if (notFound || toolName === 'reminders_delete') {
      throw new Error(notFound ? NOT_FOUND_MESSAGE : DELETE_LOOKUP_FAILED, { cause: error });
    }
    return {};
  }
}
