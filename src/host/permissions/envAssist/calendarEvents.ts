// 会前提醒读日程（ADR-090 perm_calendars）：走原生桥 /v1/read/，不打开「日历」app、不弹框。
// 原生层每次读前自己重查授权，没完全访问就拒绝；这里不传、也不信任何授权状态。
import type { MeetingUpcoming } from '../../../shared/contract/audioCapture';
import type { ShellBridgeClient } from './shellBridge/client';

interface NativeEvent { id?: unknown; title?: unknown; startMs?: unknown }

/** [fromMs, toMs) 内开始的非全天日程（过滤与排序在原生层做） */
export function createCalendarEventsReader(client: ShellBridgeClient) {
  return async (fromMs: number, toMs: number): Promise<MeetingUpcoming[]> => {
    const res = await client.post<{ events?: NativeEvent[] }>('/v1/read/calendar-events', { fromMs, toMs });
    if (!Array.isArray(res?.events)) throw new Error('env_assist_bridge:invalid_read_calendar_response');
    return res.events.flatMap((e) => (typeof e.id === 'string' && typeof e.startMs === 'number'
      ? [{ id: e.id, title: typeof e.title === 'string' ? e.title : '', startAtMs: e.startMs }]
      : []));
  };
}
