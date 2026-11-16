// 撤销一次单条日程删除（N-CALENDAR-ONE-PERMISSION-EVENTKIT 真机第三轮，爸：删一条日程不至于红色警示）。
// 删除前 calendar_delete_event 把快照（标题/时间/地点/备注/日历）存进工具结果元数据；这里只按
// 「会话 + 工具调用 id」从宿主自己的库里取快照重建，渲染层传不进任何日程内容（不能借撤销任意建日程）。
// 用户亲手点的、可再删掉的恢复操作，不再走批准卡。
// ponytail: 撤销只重建标题 / 时间 / 地点 / 备注 / 日历：重复日程的某一次被删后重建为普通日程，全天、提醒、参会人、链接不恢复，
// 同名日历按标题取第一个；要恢复这些时再扩原生快照与建日程路由。
import type { Message } from '../../../../shared/contract';
import { getConnectorRegistry } from '../../../connectors';
import { getSessionManager } from '../../../services/infra/sessionManager';

export type CalendarUndoResult = { ok: true; uid: string } | { ok: false; reason: 'not_found' | 'not_undoable' | 'already_undone' | 'restore_failed' };

interface Snapshot { calendar: string; title: string; startAtMs: number; endAtMs: number; location?: string; notes?: string }

const isSnapshot = (v: unknown): v is Snapshot => {
  const s = v as Partial<Snapshot> | null;
  return typeof s?.calendar === 'string' && typeof s.title === 'string'
    && typeof s.startAtMs === 'number' && typeof s.endAtMs === 'number';
};

/**
 * 原生桥请求体上限 64 KiB（env_assist_bridge.rs MAX_BODY_BYTES）。备注超长时截断并注明，
 * 保证日程本身一定能建回来，而不是整条撤销失败（ai-review Important）。按 UTF-8 每字最多 3 字节留足余量。
 */
const MAX_RESTORED_NOTES_CHARS = 16_000;
const NOTES_TRUNCATED_MARK = '\n…（备注过长，撤销时已截断）';
function capNotes(notes: string): string {
  return notes.length <= MAX_RESTORED_NOTES_CHARS ? notes : notes.slice(0, MAX_RESTORED_NOTES_CHARS) + NOTES_TRUNCATED_MARK;
}

// 同一条撤销正在进行时，第二次点击直接当已撤销（防并发建出两条）
const inflight = new Set<string>();

export async function undoCalendarDelete(sessionId: string, toolCallId: string): Promise<CalendarUndoResult> {
  const key = `${sessionId}|${toolCallId}`;
  if (inflight.has(key)) return { ok: false, reason: 'already_undone' };
  inflight.add(key);
  try { return await restore(sessionId, toolCallId); } finally { inflight.delete(key); }
}

async function restore(sessionId: string, toolCallId: string): Promise<CalendarUndoResult> {
  const manager = getSessionManager();
  // SessionManager applies the signed-in user's session ownership fence.
  const messages: Message[] = await manager.getMessages(sessionId);
  // 工具调用在 assistant 消息里，结果单独存在 role=tool 的消息里（Dev 库实测），两边分开找
  const isDelete = messages.some((m) => m.toolCalls?.some((c) => c.id === toolCallId && c.name === 'calendar_delete_event'));
  const message = messages.find((m) => m.toolResults?.some((r) => r.toolCallId === toolCallId));
  const results = message?.toolResults ?? [];
  const index = results.findIndex((r) => r.toolCallId === toolCallId);
  const result = results[index];
  if (!isDelete || !message || !result) return { ok: false, reason: 'not_found' };
  const meta = result.metadata ?? {};
  if (typeof meta.undoneUid === 'string') return { ok: false, reason: 'already_undone' };
  if (!result.success || meta.undoable !== true || !isSnapshot(meta.before)) return { ok: false, reason: 'not_undoable' };
  const before = meta.before;
  const connector = getConnectorRegistry().get('calendar');
  if (!connector) return { ok: false, reason: 'restore_failed' };
  let uid: string;
  try {
    const created = await connector.execute('create_event', {
      calendar: before.calendar, title: before.title, start_ms: before.startAtMs, end_ms: before.endAtMs,
      ...(before.location ? { location: before.location } : {}), ...(before.notes ? { notes: capNotes(before.notes) } : {}),
    });
    uid = String((created.data as { uid?: unknown }).uid ?? '');
  } catch {
    return { ok: false, reason: 'restore_failed' };
  }
  // 记下已撤销，重载后按钮显示「已撤销」，也挡住重复点击建出两条
  const toolResults = [...results];
  toolResults[index] = { ...result, metadata: { ...meta, undoneUid: uid } };
  await manager.updateMessage(message.id, { toolResults });
  return { ok: true, uid };
}
