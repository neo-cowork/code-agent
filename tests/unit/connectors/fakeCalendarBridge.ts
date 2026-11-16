// 测试用假原生桥：只实现日历 EventKit 路由，行为照 src-tauri/src/env_assist_bridge/calendar.rs
// （非完全访问一律 403 calendar_not_authorized、找不到 404 event_not_found、重复日程按 id+开始时间定位那一次）。
// 用法（测试文件里）：
//   const { fake } = await vi.hoisted(async () => ({ fake: (await import('./fakeCalendarBridge')).createFakeCalendarBridge() }));
//   vi.mock('<…>/permissions/envAssist/shellBridge/client', async (orig) => ({ ...(await orig()), resolveShellBridgeClientFromEnv: () => fake.client }));
import { afterEach, beforeEach } from 'vitest';

export interface FakeItem {
  id: string; calendarId: string; calendar: string; title: string; startMs: number; endMs: number;
  allDay?: boolean; recurring?: boolean; location?: string; notes?: string; url?: string;
}

const bridgeError = (message: string, code: string) => Object.assign(new Error(message), { bridgeError: code });

export function createFakeCalendarBridge() {
  const state = {
    status: 3 as 0 | 1 | 2 | 3 | 4,
    calendars: [{ id: 'c-work', title: 'Work', writable: true }] as Array<{ id: string; title: string; writable: boolean; isDefault?: boolean }>,
    items: [] as FakeItem[],
    calls: [] as Array<{ path: string; body: Record<string, unknown> }>,
    /** 点了授权框后的答复（undefined = 一直不答） */
    answer: undefined as 0 | 1 | 2 | 3 | 4 | undefined,
    grants: 0,
    nextId: 1,
  };
  const full = (item: FakeItem) => ({
    allDay: false, recurring: false, location: '', notes: '', url: '', ...item,
  });
  const find = (body: Record<string, unknown>) => {
    const i = state.items.findIndex((e) => e.id === body.eventId
      && (typeof body.occurrenceMs !== 'number' || e.startMs === body.occurrenceMs));
    if (i < 0) throw bridgeError('env_assist_bridge:bridge_http_404', 'event_not_found');
    return i;
  };
  const client = {
    async post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
      state.calls.push({ path, body });
      if (path === '/v1/passive/calendar') return { status: state.status } as T;
      if (path === '/v1/grant/calendar') {
        state.grants += 1;
        if (state.answer !== undefined) state.status = state.answer;
        return { requested: true } as T;
      }
      if (state.status !== 3) throw bridgeError('env_assist_bridge:bridge_auth_rejected', 'calendar_not_authorized');
      switch (path) {
        case '/v1/read/calendars': return { calendars: state.calendars } as T;
        case '/v1/read/calendar-items': {
          const { fromMs, toMs, calendarId, limit } = body as { fromMs: number; toMs: number; calendarId?: string; limit?: number };
          if (calendarId && !state.calendars.some((c) => c.id === calendarId)) throw bridgeError('env_assist_bridge:bridge_http_404', 'calendar_not_found');
          const events = state.items
            .filter((e) => (!calendarId || e.calendarId === calendarId) && e.endMs >= fromMs && e.startMs <= toMs)
            .sort((a, b) => a.startMs - b.startMs)
            .slice(0, limit ?? 200)
            .map(full);
          return { events } as T;
        }
        case '/v1/read/calendar-event': return { event: full(state.items[find(body)]) } as T;
        case '/v1/write/calendar-event': {
          if (body.op === 'create') {
            const cal = body.calendarId ? state.calendars.find((c) => c.id === body.calendarId) : state.calendars.find((c) => c.writable);
            if (!cal) throw bridgeError('env_assist_bridge:bridge_http_404', 'no_writable_calendar');
            const item: FakeItem = {
              id: `ev-${state.nextId++}`, calendarId: cal.id, calendar: cal.title, title: String(body.title),
              startMs: Number(body.startMs), endMs: Number(body.endMs), location: typeof body.location === 'string' ? body.location : '',
            };
            state.items.push(item);
            return { event: full(item) } as T;
          }
          const i = find(body);
          if (body.op === 'delete') {
            const [removed] = state.items.splice(i, 1);
            return { deleted: true, title: removed.title } as T;
          }
          const item = state.items[i];
          if (typeof body.title === 'string') item.title = body.title;
          if (typeof body.startMs === 'number') item.startMs = body.startMs;
          if (typeof body.endMs === 'number') item.endMs = body.endMs;
          if (typeof body.location === 'string') item.location = body.location;
          return { event: full(item) } as T;
        }
        default: throw bridgeError('env_assist_bridge:bridge_http_404', 'not_found');
      }
    },
  };
  const reset = () => {
    Object.assign(state, { status: 3, items: [], calls: [], answer: undefined, grants: 0, nextId: 1 });
    state.calendars = [{ id: 'c-work', title: 'Work', writable: true }];
  };
  return { client, state, reset, paths: () => state.calls.map((c) => c.path) };
}

/** 日历连接器只在 macOS 上找原生桥：测试里把平台钉成 darwin（CI 是 Linux）。 */
export function useDarwinPlatform(): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'darwin' }); });
  afterEach(() => { Object.defineProperty(process, 'platform', original); });
}
