// ============================================================================
// Native Calendar Connector - macOS Calendar via EventKit (ADR-090 perm_calendars)
//
// 走桌面壳原生桥的 EventKit 路由（src-tauri/src/env_assist_calendar_items.rs），与会前提醒是同一项「日历」授权：
// 不打开「日历」app、主机不起任何脚本子进程、从不弹框（弹框只在用户点击签发的凭证里，见 envAssist/calendarGrant.ts 与 ipc/envAssist.ipc.ts）。
// 原生层每次读写前自己重查「完全访问」，这里不传、也不信任何授权状态。
// ============================================================================

import type { Connector, ConnectorExecutionResult, ConnectorStatus } from '../base';
import type { CalendarAccess } from '../../permissions/envAssist/probes/passiveProbes';
import { calendarAccess } from '../../permissions/envAssist/probes/passiveProbes';
import { createShellPassiveBridge } from '../../permissions/envAssist/probes/shellPassiveBridge';
import { bridgeErrorCode, resolveShellBridgeClientFromEnv, type ShellBridgeClient } from '../../permissions/envAssist/shellBridge/client';

interface CalendarEventItem {
  uid: string;
  calendar: string;
  title: string;
  startAtMs: number | null;
  endAtMs: number | null;
  location?: string;
  notes?: string;
  url?: string;
}

interface NativeCalendar { id: string; title: string; writable: boolean; isDefault?: boolean }
interface NativeItem {
  id: string; calendar: string; title: string; startMs: number; endMs: number;
  recurring: boolean; location: string; notes: string; url: string;
}

/** Same caps as the native route (MAX_ITEMS_WINDOW_MS / MAX_ITEMS). */
const MAX_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_LIMIT = 200;

export type CalendarFailureCode = 'not_authorized' | 'not_found' | 'unavailable' | 'read_failed';

const FAILURE_MESSAGES: Record<CalendarFailureCode, string> = {
  not_authorized: 'Calendar access has not been allowed yet. （还没有允许 Neo 访问日历。）',
  not_found: 'No calendar event or calendar matches that id/name. Event uids from earlier in this conversation may be stale: call calendar list_events again and use the uid it returns. （找不到对应的日程或日历：之前拿到的 uid 可能已失效，请重新 list_events 后用新的 uid。）',
  unavailable: 'Calendar is only available in the Agent Neo desktop app on macOS. （日历只能在 macOS 的 Agent Neo 桌面版里使用。）',
  read_failed: 'Calendar could not be read or changed right now; please try again later. （日历暂时读写失败，请稍后再试。）',
};

/** Failures carry a machine code (classify / parking read it) and a model-facing sentence without native detail. */
export class CalendarFailure extends Error {
  constructor(readonly code: CalendarFailureCode, message = FAILURE_MESSAGES[code]) {
    super(message);
    this.name = 'CalendarFailure';
  }
}

export function isCalendarFailure(error: unknown): error is CalendarFailure {
  return error instanceof CalendarFailure;
}

const WRITE_UNCONFIRMED = 'Calendar did not confirm the change, so the result is unknown. Check the calendar before retrying; do not retry blindly. （日历没有确认这次修改，结果无法确认：请先查看日历是否已改好，不要直接重试。）';

function failureFromBridge(error: unknown, write: boolean): CalendarFailure {
  if (isCalendarFailure(error)) return error;
  switch (bridgeErrorCode(error)) {
    case 'calendar_not_authorized': return new CalendarFailure('not_authorized');
    case 'event_not_found': case 'calendar_not_found': return new CalendarFailure('not_found');
    case 'event_end_not_after_start':
      return new CalendarFailure('read_failed', 'The new end time must be later than the start time. Nothing was changed. （新的结束时间必须晚于开始时间，日程没有被修改。）');
    case 'no_writable_calendar':
      return new CalendarFailure('not_found', 'No writable calendar is available. Omit calendar to use the first writable calendar.');
    // 写操作超时 / 桥断开：改没改成不知道，不能劝模型重试
    default: return write ? new CalendarFailure('read_failed', WRITE_UNCONFIRMED) : new CalendarFailure('read_failed');
  }
}

// ponytail: one shell bridge per process (the shell hands credentials over once); reset drops it for tests.
let cachedClient: ShellBridgeClient | null | undefined;
function bridge(): ShellBridgeClient | null {
  if (cachedClient === undefined) cachedClient = process.platform === 'darwin' ? resolveShellBridgeClientFromEnv() : null;
  return cachedClient;
}

async function call<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const client = bridge();
  if (!client) throw new CalendarFailure('unavailable');
  try {
    return await client.post<T>(path, body);
  } catch (error) {
    throw failureFromBridge(error, path.startsWith('/v1/write/'));
  }
}

// 最近一次被动探针（从不弹框）的结果；只用于 getCachedStatus。永不缓存 failed：未授权也保留工具，调用时原生层 403 → 出卡。
let lastAccess: CalendarAccess | undefined;
let lastCheckedAt: number | undefined;
let lastListEmpty = false;

export function resetCalendarConnectorReadiness(): void {
  cachedClient = undefined;
  lastAccess = undefined;
  lastCheckedAt = undefined;
  lastListEmpty = false;
}

/** The single calendar authorization truth (same probe as the card and the meeting reminder switch). */
async function readCalendarAccess(): Promise<CalendarAccess> {
  const client = bridge();
  lastAccess = client ? await calendarAccess(createShellPassiveBridge(client)) : 'unavailable';
  lastCheckedAt = Date.now();
  return lastAccess;
}

const ACCESS_DETAIL: Record<Exclude<CalendarAccess, 'granted'>, string> = {
  undecided: '还没有允许 Neo 访问日历；用到日历时会请你允许一次。',
  denied: '日历访问被拒绝了：请在「系统设置 → 隐私与安全性 → 日历」里允许 Neo。',
  write_only: '日历只给了「仅添加事件」：请在「系统设置 → 隐私与安全性 → 日历」里改成「完全访问」。',
  restricted: '日历访问被系统限制（家长控制或公司管理），Neo 改不了。',
  unavailable: '日历只能在 macOS 的 Agent Neo 桌面版里使用。',
};

function buildCalendarStatus(capabilities: string[]): ConnectorStatus {
  if (process.platform !== 'darwin') {
    return { connected: false, readiness: 'unavailable', detail: 'Calendar connector 仅在 macOS 可用。', actions: [], capabilities };
  }
  if (lastAccess === 'granted') {
    return {
      connected: true, readiness: 'ready', checkedAt: lastCheckedAt,
      detail: 'Calendar connector 已允许访问日历。', noAccessibleItems: lastListEmpty,
      actions: ['disconnect', 'remove'], capabilities,
    };
  }
  return {
    connected: false,
    // 未授权不是「坏了」：按需探测口径算 unchecked，工具照常可用，调用时出授权卡（不写 failed，免得整轮摘掉工具）
    readiness: 'unchecked',
    checkedAt: lastCheckedAt,
    detail: lastAccess ? ACCESS_DETAIL[lastAccess] : 'Calendar connector 已启用，用到时才检查日历授权。',
    actions: ['repair_permissions', 'disconnect', 'remove'],
    capabilities,
  };
}

async function listCalendarInfos(): Promise<NativeCalendar[]> {
  const res = await call<{ calendars?: NativeCalendar[] }>('/v1/read/calendars');
  if (!Array.isArray(res?.calendars)) throw new CalendarFailure('read_failed');
  return res.calendars;
}

function resolveCalendar(requestedName: string, available: NativeCalendar[]): NativeCalendar {
  const exact = available.find((c) => c.title === requestedName);
  if (exact) return exact;
  const loose = available.filter((c) => c.title.toLowerCase() === requestedName.toLowerCase());
  if (loose.length === 1) return loose[0];
  const names = available.length > 0 ? available.map((c) => c.title).join(', ') : '(none)';
  throw new Error(
    `No calendar named "${requestedName}". Available calendars: ${names}. Omit calendar to use the first writable calendar.`,
  );
}

/** A recurring series shares one EventKit id; the uid adds that occurrence's start so writes hit only it. */
function toUid(item: NativeItem): string {
  return item.recurring ? `${item.id}@${item.startMs}` : item.id;
}

function parseCalendarUid(uid: string): { eventId: string; occurrenceMs?: number } {
  const match = /^(.+)@(-?\d+)$/.exec(uid);
  return match ? { eventId: match[1], occurrenceMs: Number(match[2]) } : { eventId: uid };
}

function toEvent(item: NativeItem): CalendarEventItem {
  return {
    uid: toUid(item),
    calendar: item.calendar,
    title: item.title,
    startAtMs: Number.isFinite(item.startMs) ? item.startMs : null,
    endAtMs: Number.isFinite(item.endMs) ? item.endMs : null,
    location: item.location || undefined,
    notes: item.notes || undefined,
    url: item.url || undefined,
  };
}

function eventOf(res: { event?: NativeItem } | undefined): CalendarEventItem {
  if (!res?.event || typeof res.event.id !== 'string') throw new CalendarFailure('read_failed');
  return toEvent(res.event);
}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

async function listEvents(payload: Record<string, unknown>): Promise<CalendarEventItem[]> {
  const calendarName = str(payload.calendar);
  const fromMs = finite(payload.from_ms) ?? new Date().setHours(0, 0, 0, 0);
  const requestedTo = finite(payload.to_ms) ?? Date.now() + 14 * 24 * 60 * 60 * 1000;
  // ponytail: an over-long range is clamped to the native cap instead of failing; split the range if that ever matters.
  const toMs = Math.min(Math.max(requestedTo, fromMs + 1), fromMs + MAX_WINDOW_MS);
  const limit = Math.max(1, Math.min(Math.floor(finite(payload.limit) ?? 20), MAX_LIMIT));
  const calendarId = calendarName ? resolveCalendar(calendarName, await listCalendarInfos()).id : undefined;
  const res = await call<{ events?: NativeItem[] }>('/v1/read/calendar-items', {
    fromMs, toMs, limit, ...(calendarId ? { calendarId } : {}),
  });
  if (!Array.isArray(res?.events)) throw new CalendarFailure('read_failed');
  return res.events.map(toEvent);
}

function requireEventArgs(payload: Record<string, unknown>, action: string): { calendar: string; uid: string } {
  const calendar = str(payload.calendar);
  const uid = str(payload.event_uid);
  if (!calendar) throw new Error(`calendar is required for ${action}`);
  if (!uid) throw new Error(`event_uid is required for ${action}`);
  return { calendar, uid };
}

async function getEvent(payload: Record<string, unknown>): Promise<CalendarEventItem> {
  const { uid } = requireEventArgs(payload, 'get_event');
  const { eventId, occurrenceMs } = parseCalendarUid(uid);
  return eventOf(await call('/v1/read/calendar-event', { eventId, ...(occurrenceMs !== undefined ? { occurrenceMs } : {}) }));
}

async function createEvent(payload: Record<string, unknown>): Promise<CalendarEventItem> {
  const requestedCalendar = str(payload.calendar);
  const title = str(payload.title);
  const startMs = finite(payload.start_ms);
  const endMs = finite(payload.end_ms) ?? (startMs !== undefined ? startMs + 30 * 60 * 1000 : undefined);
  const location = str(payload.location);
  // notes：聊天建日程的可选备注，以及撤销删除时用快照重建都会带；非空才下发给 EventKit
  const notes = str(payload.notes);
  if (!title) throw new Error('title is required for create_event');
  if (startMs === undefined) throw new Error('start_ms is required for create_event');
  if (endMs === undefined || endMs < startMs) throw new Error('end_ms must be greater than or equal to start_ms');
  const calendarId = requestedCalendar
    ? resolveCalendar(requestedCalendar, (await listCalendarInfos()).filter((c) => c.writable)).id
    : undefined; // 原生层用系统的默认日历
  return eventOf(await call('/v1/write/calendar-event', {
    op: 'create', title, startMs, endMs,
    ...(calendarId ? { calendarId } : {}), ...(location ? { location } : {}), ...(notes ? { notes } : {}),
  }));
}

// Start only: the native layer keeps the event's duration (end moves with it). To change the length give both.
async function updateEvent(payload: Record<string, unknown>): Promise<CalendarEventItem> {
  const { uid } = requireEventArgs(payload, 'update_event');
  const title = typeof payload.title === 'string' ? payload.title.trim() : undefined;
  const startMs = finite(payload.start_ms);
  const endMs = finite(payload.end_ms);
  const location = typeof payload.location === 'string' ? payload.location.trim() : undefined;
  if (!title && startMs === undefined && endMs === undefined && location === undefined) {
    throw new Error('at least one field must be provided for update_event');
  }
  if (endMs !== undefined && startMs === undefined) throw new Error('start_ms is required when end_ms is provided');
  if (startMs !== undefined && endMs !== undefined && endMs < startMs) {
    throw new Error('end_ms must be greater than or equal to start_ms');
  }
  const { eventId, occurrenceMs } = parseCalendarUid(uid);
  return eventOf(await call('/v1/write/calendar-event', {
    op: 'update', eventId,
    ...(occurrenceMs !== undefined ? { occurrenceMs } : {}),
    ...(title ? { title } : {}),
    ...(startMs !== undefined ? { startMs } : {}),
    ...(endMs !== undefined ? { endMs } : {}),
    ...(location !== undefined ? { location } : {}),
  }));
}

async function deleteEvent(payload: Record<string, unknown>): Promise<{ uid: string; calendar: string; title: string; deleted: boolean }> {
  const { calendar, uid } = requireEventArgs(payload, 'delete_event');
  const { eventId, occurrenceMs } = parseCalendarUid(uid);
  const res = await call<{ deleted?: boolean; title?: string }>('/v1/write/calendar-event', {
    op: 'delete', eventId, ...(occurrenceMs !== undefined ? { occurrenceMs } : {}),
  });
  if (res?.deleted !== true) throw new CalendarFailure('read_failed');
  return { uid, calendar, title: typeof res.title === 'string' ? res.title : '', deleted: true };
}

/** probe_access: passive only (startup / background callers must never prompt). Lists calendars when granted. */
async function probe(): Promise<number | null> {
  if ((await readCalendarAccess()) !== 'granted') return null;
  const calendars = await listCalendarInfos();
  lastListEmpty = calendars.length === 0;
  return calendars.length;
}

function probeSummary(count: number | null): string {
  if (count === null) return `Calendar 还没有允许访问：${ACCESS_DETAIL[(lastAccess ?? 'undecided') as Exclude<CalendarAccess, 'granted'>]}`;
  return count > 0 ? `Calendar 授权/可用性检查通过，可访问 ${count} 个日历` : 'Calendar 授权/可用性检查通过，但没有找到可访问的日历';
}

export const calendarConnector: Connector = {
  id: 'calendar',
  label: 'Calendar',
  capabilities: ['get_status', 'list_calendars', 'list_events', 'create_event', 'update_event', 'delete_event'],
  getCachedStatus(): ConnectorStatus {
    return buildCalendarStatus(this.capabilities);
  },
  async getStatus(): Promise<ConnectorStatus> {
    if (process.platform === 'darwin') await readCalendarAccess();
    return buildCalendarStatus(this.capabilities);
  },
  async execute(action: string, payload: Record<string, unknown>): Promise<ConnectorExecutionResult> {
    switch (action) {
      case 'get_status':
        return { data: await this.getStatus() };
      case 'probe_access': {
        const count = await probe();
        return { data: buildCalendarStatus(this.capabilities), summary: probeSummary(count) };
      }
      case 'repair_permissions': {
        // 用户在连接器页点「修复权限」：与授权卡、会前提醒开关同一个授权出口（点击凭证弹一次 / 已拒绝开系统设置）
        const { grantCalendarFromConnectorClick } = await import('../../ipc/envAssist.ipc');
        await grantCalendarFromConnectorClick();
        const count = await probe();
        return { data: buildCalendarStatus(this.capabilities), summary: probeSummary(count) };
      }
      case 'disconnect':
      case 'remove':
        resetCalendarConnectorReadiness();
        return {
          data: buildCalendarStatus(this.capabilities),
          summary: action === 'disconnect' ? 'Calendar connector 已断开。' : 'Calendar connector 已移除。',
        };
      case 'default_calendar': {
        // 不指定日历时会写进哪个日历（系统「新事件默认日历」），给批准卡显示；拿不到就是 null，卡上不显示这一行
        const title = (await listCalendarInfos()).find((c) => c.isDefault && c.writable)?.title ?? null;
        return { data: title };
      }
      case 'list_calendars': {
        const calendars = (await listCalendarInfos()).map((c) => c.title);
        return { data: calendars, summary: calendars.length > 0 ? `找到 ${calendars.length} 个日历` : '没有找到可访问的日历' };
      }
      case 'list_events': {
        const events = await listEvents(payload);
        return { data: events, summary: events.length > 0 ? `找到 ${events.length} 条日历事件` : '没有找到匹配的日历事件' };
      }
      case 'get_event': {
        const event = await getEvent(payload);
        return { data: event, summary: `找到日历事件：${event.title}` };
      }
      case 'create_event': {
        const event = await createEvent(payload);
        return { data: event, summary: `已创建日历事件：${event.title}` };
      }
      case 'update_event': {
        const event = await updateEvent(payload);
        return { data: event, summary: `已更新日历事件：${event.title}` };
      }
      case 'delete_event': {
        const event = await deleteEvent(payload);
        return { data: event, summary: `已删除日历事件：${event.title}` };
      }
      default:
        throw new Error(`Unsupported calendar action: ${action}`);
    }
  },
};
