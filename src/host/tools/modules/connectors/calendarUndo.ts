// 撤销一次单条日程删除（N-CALENDAR-ONE-PERMISSION-EVENTKIT 真机第三轮，爸：删一条日程不至于红色警示）。
// 删除前 calendar_delete_event 把快照（标题/时间/地点/备注/日历）存进工具结果元数据；这里只按
// 「会话 + 工具调用 id」从宿主自己的库里取快照重建，渲染层传不进任何日程内容（不能借撤销任意建日程）。
// 用户亲手点的、可再删掉的恢复操作，不再走批准卡。
// ponytail: 重复日程的某一次被删后，撤销重建的是一条普通日程（不恢复整个系列）；要恢复系列时再做。
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
  const message = messages.find((m) => m.toolCalls?.some((c) => c.id === toolCallId && c.name === 'calendar_delete_event'));
  const results = message?.toolResults ?? [];
  const index = results.findIndex((r) => r.toolCallId === toolCallId);
  const result = results[index];
  if (!message || !result) return { ok: false, reason: 'not_found' };
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
      ...(before.location ? { location: before.location } : {}), ...(before.notes ? { notes: before.notes } : {}),
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
