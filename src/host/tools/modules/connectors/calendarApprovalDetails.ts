// 日历写回的批准卡要显示的补充信息：只给卡片看，不改工具参数（N-CALENDAR-ONE-PERMISSION-EVENTKIT 真机第四轮）。
// 必须在工具执行前那唯一一次审批里补上：工具体内 canUseTool 一旦拿到和已批准不同的参数，就会再弹一张卡
// （真机第四轮：建 / 删各弹了两张，第二张 sessionId 还是空的）。
// - 建日程没指定日历：补上实际会写进的系统默认日历名；
// - 删日程：补上要删那条的标题、时间、地点、所在日历。
// 取不到（未授权、桥不通、找不到）就什么都不补，卡片照常出，只是少几行。
import { getConnectorRegistry } from '../../../connectors';

export async function calendarApprovalDetails(toolName: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const connector = toolName === 'calendar_create_event' || toolName === 'calendar_delete_event'
    ? getConnectorRegistry().get('calendar')
    : undefined;
  if (!connector) return {};
  try {
    if (toolName === 'calendar_create_event') {
      if (typeof params.calendar === 'string' && params.calendar.trim()) return {};
      const { data } = await connector.execute('default_calendar', {});
      return typeof data === 'string' && data ? { calendar: data } : {};
    }
    const { data } = await connector.execute('get_event', params);
    const event = data as { calendar?: unknown; title?: unknown; startAtMs?: unknown; endAtMs?: unknown; location?: unknown };
    return {
      ...(typeof event.calendar === 'string' ? { calendar: event.calendar } : {}),
      ...(typeof event.title === 'string' ? { title: event.title } : {}),
      ...(typeof event.startAtMs === 'number' ? { start_ms: event.startAtMs } : {}),
      ...(typeof event.endAtMs === 'number' ? { end_ms: event.endAtMs } : {}),
      ...(typeof event.location === 'string' && event.location ? { location: event.location } : {}),
    };
  } catch {
    return {};
  }
}
