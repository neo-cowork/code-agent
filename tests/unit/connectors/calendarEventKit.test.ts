// 聊天日历工具的原生连接器（N-CALENDAR-ONE-PERMISSION-EVENTKIT）：走原生桥 EventKit，不跑 AppleScript。
// 证据档位：hermetic-protocol（假原生桥照 Rust 路由行为；真 EventKit 由 cargo test + 真机验）。
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fake } = await vi.hoisted(async () => ({ fake: (await import('./fakeCalendarBridge')).createFakeCalendarBridge() }));
vi.mock('../../../src/host/permissions/envAssist/shellBridge/client', async (orig) => ({
  ...(await orig<typeof import('../../../src/host/permissions/envAssist/shellBridge/client')>()),
  resolveShellBridgeClientFromEnv: () => fake.client,
}));
const runAppleScript = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/connectors/native/osascript', async (orig) => ({
  ...(await orig<typeof import('../../../src/host/connectors/native/osascript')>()),
  runAppleScript,
}));

import { calendarConnector, isCalendarFailure, resetCalendarConnectorReadiness } from '../../../src/host/connectors/native/calendar';
import { useDarwinPlatform } from './fakeCalendarBridge';

useDarwinPlatform();
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

beforeEach(() => {
  fake.reset();
  resetCalendarConnectorReadiness();
  runAppleScript.mockReset();
});

const failureOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe('calendar connector over EventKit', () => {
  it('never runs AppleScript and never asks for the Apple-events (Calendar.app) permission', async () => {
    fake.state.items.push({ id: 'e1', calendarId: 'c-work', calendar: 'Work', title: '周会', startMs: 1_000, endMs: 2_000 });
    await calendarConnector.execute('list_calendars', {});
    await calendarConnector.execute('list_events', { from_ms: 0, to_ms: HOUR });
    expect(runAppleScript).not.toHaveBeenCalled();
    const source = readFileSync('src/host/connectors/native/calendar.ts', 'utf8');
    expect(source).not.toMatch(/osascript|runAppleScript|com\.apple\.iCal|tell application/);
  });

  it('lists events overlapping the window from the named calendar, earliest first, capped by limit', async () => {
    fake.state.calendars.push({ id: 'c-home', title: '家庭', writable: true });
    fake.state.items.push(
      { id: 'b', calendarId: 'c-work', calendar: 'Work', title: 'B', startMs: 3 * HOUR, endMs: 4 * HOUR },
      { id: 'a', calendarId: 'c-work', calendar: 'Work', title: 'A', startMs: -HOUR, endMs: HOUR / 2, location: '三楼' },
      { id: 'h', calendarId: 'c-home', calendar: '家庭', title: 'H', startMs: HOUR, endMs: 2 * HOUR },
    );
    const { data } = await calendarConnector.execute('list_events', { calendar: 'work', from_ms: 0, to_ms: 10 * HOUR, limit: 5 });
    expect(data).toEqual([
      { uid: 'a', calendar: 'Work', title: 'A', startAtMs: -HOUR, endAtMs: HOUR / 2, location: '三楼', notes: undefined, url: undefined },
      expect.objectContaining({ uid: 'b', title: 'B' }),
    ]);
    expect(fake.state.calls.at(-1)?.body).toEqual({ fromMs: 0, toMs: 10 * HOUR, limit: 5, calendarId: 'c-work' });
    await expect(calendarConnector.execute('list_events', { calendar: 'Missing' })).rejects.toThrow(
      'No calendar named "Missing". Available calendars: Work, 家庭.',
    );
  });

  it('a recurring occurrence gets uid id@start; update/delete address only that occurrence', async () => {
    fake.state.items.push(
      { id: 'series', calendarId: 'c-work', calendar: 'Work', title: '周会', startMs: HOUR, endMs: 2 * HOUR, recurring: true },
      { id: 'series', calendarId: 'c-work', calendar: 'Work', title: '周会', startMs: HOUR + WEEK, endMs: 2 * HOUR + WEEK, recurring: true },
    );
    const { data } = await calendarConnector.execute('list_events', { from_ms: 0, to_ms: 2 * WEEK });
    const uids = (data as Array<{ uid: string }>).map((e) => e.uid);
    expect(uids).toEqual([`series@${HOUR}`, `series@${HOUR + WEEK}`]);

    const got = await calendarConnector.execute('get_event', { calendar: 'Work', event_uid: uids[1] });
    expect(got.data).toMatchObject({ uid: uids[1], startAtMs: HOUR + WEEK });

    await calendarConnector.execute('update_event', { calendar: 'Work', event_uid: uids[1], title: '改期' });
    expect(fake.state.items.map((e) => e.title)).toEqual(['周会', '改期']);
    expect(fake.state.calls.at(-1)?.body).toEqual({ op: 'update', eventId: 'series', occurrenceMs: HOUR + WEEK, title: '改期' });

    const deleted = await calendarConnector.execute('delete_event', { calendar: 'Work', event_uid: uids[1] });
    expect(deleted.data).toEqual({ uid: uids[1], calendar: 'Work', title: '改期', deleted: true });
    expect(fake.state.items.map((e) => e.startMs)).toEqual([HOUR]);
  });

  it('a uid from the old AppleScript channel is a clear not_found telling the model to list again, not read_failed', async () => {
    const error = await failureOf(calendarConnector.execute('update_event', {
      calendar: 'Work', event_uid: '9A2C1E8F-OLD-APPLESCRIPT-UID', title: 'x',
    }));
    expect(isCalendarFailure(error) && error.code).toBe('not_found');
    expect((error as Error).message).toContain('call calendar list_events again');
  });

  it('passes notes (CJK + newline) to EventKit unchanged and returns them; sends no notes key when absent', async () => {
    const notes = '带上季度报表\n第二行';
    const created = await calendarConnector.execute('create_event', { title: '周会', start_ms: HOUR, notes });
    expect(fake.state.calls.at(-1)?.body).toEqual({ op: 'create', title: '周会', startMs: HOUR, endMs: HOUR + 30 * 60_000, notes });
    expect(created.data).toMatchObject({ title: '周会', notes });

    await calendarConnector.execute('create_event', { title: '无备注', start_ms: HOUR, notes: '   ' });
    expect(fake.state.calls.at(-1)?.body).not.toHaveProperty('notes');
  });

  it('creates in the named writable calendar (case-insensitive), or the system default; rejects unknown names before writing', async () => {
    fake.state.calendars = [
      { id: 'c-holidays', title: '节假日', writable: false },
      { id: 'c-cal', title: '日历', writable: true },
    ];
    const created = await calendarConnector.execute('create_event', { calendar: '日历', title: '评审', start_ms: HOUR, location: '三楼' });
    expect(created.data).toMatchObject({ calendar: '日历', title: '评审', startAtMs: HOUR, endAtMs: HOUR + 30 * 60_000, location: '三楼' });
    expect(fake.state.calls.at(-1)?.body).toEqual({ op: 'create', title: '评审', startMs: HOUR, endMs: HOUR + 30 * 60_000, calendarId: 'c-cal', location: '三楼' });

    await calendarConnector.execute('create_event', { title: '默认', start_ms: HOUR, end_ms: 2 * HOUR });
    expect(fake.state.calls.at(-1)?.body).toEqual({ op: 'create', title: '默认', startMs: HOUR, endMs: 2 * HOUR });

    const writesBefore = fake.paths().filter((p) => p.startsWith('/v1/write/')).length;
    await expect(calendarConnector.execute('create_event', { calendar: '节假日', title: 'x', start_ms: 1 })).rejects.toThrow(
      'No calendar named "节假日". Available calendars: 日历.',
    );
    expect(fake.paths().filter((p) => p.startsWith('/v1/write/')).length).toBe(writesBefore);

    fake.state.calendars = [];
    const error = await failureOf(calendarConnector.execute('create_event', { title: 'x', start_ms: 1 }));
    expect((error as Error).message).toBe('No writable calendar is available. Omit calendar to use the first writable calendar.');
  });

  it('default_calendar names the system default for new events, or null when it is not writable / not known', async () => {
    fake.state.calendars = [
      { id: 'c-work', title: 'Work', writable: true },
      { id: 'c-home', title: '家庭', writable: true, isDefault: true },
    ];
    expect((await calendarConnector.execute('default_calendar', {})).data).toBe('家庭');
    fake.state.calendars = [{ id: 'c-work', title: 'Work', writable: true }];
    expect((await calendarConnector.execute('default_calendar', {})).data).toBeNull();
  });

  it('start-only update keeps the duration and sends only startMs', async () => {
    fake.state.items.push({ id: 'e1', calendarId: 'c-work', calendar: 'Work', title: '周会', startMs: 10 * HOUR, endMs: 11 * HOUR });
    const res = await calendarConnector.execute('update_event', { calendar: 'Work', event_uid: 'e1', start_ms: 16 * HOUR });
    expect(res.data).toMatchObject({ startAtMs: 16 * HOUR, endAtMs: 17 * HOUR });
    const write = fake.state.calls.find((c) => c.path === '/v1/write/calendar-event')!;
    expect(write.body.startMs).toBe(16 * HOUR);
    expect('endMs' in write.body).toBe(false);
  });

  it('native event_end_not_after_start surfaces as a plain message, not WRITE_UNCONFIRMED', async () => {
    const realPost = fake.client.post;
    fake.client.post = async <T>(path: string, body?: Record<string, unknown>): Promise<T> => {
      if (path === '/v1/write/calendar-event') throw Object.assign(new Error('env_assist_bridge:bridge_http_400'), { bridgeError: 'event_end_not_after_start' });
      return realPost<T>(path, body);
    };
    try {
      const error = await failureOf(calendarConnector.execute('update_event', { calendar: 'Work', event_uid: 'e1', start_ms: 1, end_ms: 2 }));
      expect(isCalendarFailure(error)).toBe(true);
      expect((error as Error).message).toContain('must be later than the start');
      expect((error as Error).message).not.toContain('result is unknown');
    } finally {
      fake.client.post = realPost;
    }
  });

  it('keeps the old argument validation messages', async () => {
    await expect(calendarConnector.execute('create_event', { start_ms: 1 })).rejects.toThrow('title is required for create_event');
    await expect(calendarConnector.execute('update_event', { calendar: 'Work', event_uid: 'e' })).rejects.toThrow('at least one field must be provided for update_event');
    await expect(calendarConnector.execute('update_event', { calendar: 'Work', event_uid: 'e', end_ms: 5 })).rejects.toThrow('start_ms is required when end_ms is provided');
    await expect(calendarConnector.execute('delete_event', { calendar: 'Work' })).rejects.toThrow('event_uid is required for delete_event');
    expect(fake.state.calls).toEqual([]);
  });

  it('anything short of full access is not_authorized for reads and writes, and nothing prompts', async () => {
    for (const status of [0, 1, 2, 4] as const) {
      fake.reset();
      fake.state.status = status;
      for (const [action, args] of [
        ['list_events', {}], ['list_calendars', {}],
        ['create_event', { title: 't', start_ms: 1 }], ['delete_event', { calendar: 'Work', event_uid: 'e' }],
      ] as const) {
        const error = await failureOf(calendarConnector.execute(action, args));
        expect(isCalendarFailure(error) && error.code, `${action} @${status}`).toBe('not_authorized');
      }
      expect(fake.state.grants).toBe(0);
    }
  });

  it('readiness never caches failed: not granted stays usable (unchecked) so the tool is kept and the card can show', async () => {
    fake.state.status = 2;
    await calendarConnector.execute('probe_access', {});
    expect(calendarConnector.getCachedStatus!()).toMatchObject({ connected: false, readiness: 'unchecked' });
    await failureOf(calendarConnector.execute('list_events', {}));
    expect(calendarConnector.getCachedStatus!().readiness).toBe('unchecked');
    // 授权后下一次读状态立刻是 ready（现读被动探针，不靠缓存）
    fake.state.status = 3;
    expect(await calendarConnector.getStatus()).toMatchObject({ connected: true, readiness: 'ready' });
    expect(fake.state.grants).toBe(0);
  });

  it('probe_access is passive: it lists calendars only when granted and flags an empty list', async () => {
    fake.state.calendars = [];
    const result = await calendarConnector.execute('probe_access', {});
    expect(result.data).toMatchObject({ readiness: 'ready', noAccessibleItems: true });
    fake.state.status = 0;
    resetCalendarConnectorReadiness();
    const undecided = await calendarConnector.execute('probe_access', {});
    expect(undecided.data).toMatchObject({ readiness: 'unchecked', connected: false });
    expect(fake.paths().filter((p) => p === '/v1/grant/calendar')).toEqual([]);
  });

  it('connector page「修复权限」is the same single exit: one EventKit dialog, then ready — never the Apple-events dialog', async () => {
    fake.state.status = 0;
    fake.state.answer = 3; // user clicks Allow in the one dialog
    const result = await calendarConnector.execute('repair_permissions', {});
    expect(fake.state.grants).toBe(1);
    expect(result.data).toMatchObject({ connected: true, readiness: 'ready' });
    expect(runAppleScript).not.toHaveBeenCalled();
    // Already granted: clicking again shows no dialog.
    await calendarConnector.execute('repair_permissions', {});
    expect(fake.state.grants).toBe(1);
  });

  it('without the desktop shell bridge the connector is unavailable (no AppleScript fallback)', async () => {
    const client = fake.client;
    (fake as { client: unknown }).client = null;
    try {
      resetCalendarConnectorReadiness();
      const error = await failureOf(calendarConnector.execute('list_events', {}));
      expect(isCalendarFailure(error) && error.code).toBe('unavailable');
      expect(runAppleScript).not.toHaveBeenCalled();
    } finally {
      (fake as { client: unknown }).client = client;
    }
  });
});
