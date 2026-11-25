// Evidence class: hermetic-protocol（假原生桥）。验收③④：巡检只走被动探针 + /v1/read/，提醒后点「记这场会」用日程名做标题，绝不自动开录。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEETING_SESSION_LIMITS } from '../../../../src/shared/constants';

const h = vi.hoisted(() => ({
  posts: [] as string[],
  status: 3,
  events: [] as Array<{ id: string; title: string; startMs: number }>,
  started: [] as Array<string | undefined>,
  notified: [] as string[],
  current: null as null | { state: string },
  bridgeAvailable: true,
  calendarReminder: true,
  configThrows: null as Error | null,
  calendarAccessThrows: null as Error | null,
  eventsThrows: null as Error | null,
  notifyThrows: null as Error | null,
  warn: vi.fn(),
}));

vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<object>(), createLogger: () => ({ warn: h.warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/host/permissions/envAssist/probes/passiveProbes', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../../src/host/permissions/envAssist/probes/passiveProbes')>();
  return {
    ...orig,
    calendarAccess: async (bridge: Parameters<typeof orig.calendarAccess>[0]) => {
      if (h.calendarAccessThrows) throw h.calendarAccessThrows;
      return orig.calendarAccess(bridge);
    },
  };
});
vi.mock('../../../../src/host/permissions/envAssist/shellBridge/client', () => ({
  resolveShellBridgeClientFromEnv: () => (h.bridgeAvailable ? {
    post: async (path: string) => {
      h.posts.push(path);
      if (path === '/v1/passive/calendar') return { status: h.status };
      if (path === '/v1/read/calendar-events') {
        if (h.eventsThrows) throw h.eventsThrows;
        return { events: h.events };
      }
      throw new Error(`unexpected ${path}`);
    },
  } : null),
}));
vi.mock('../../../../src/host/services/desktop/desktopAudioCapture', () => ({
  getAudioCaptureStatus: () => ({ capturing: false }), getSqlitePath: () => '/dev/null',
}));
vi.mock('../../../../src/host/services/desktop/meetingSession', () => ({
  createSqliteMeetingStore: () => ({}),
  MeetingSession: class {
    status() { return { current: h.current, silenceWarning: false, lastEnded: null }; }
    async start(title?: string) { h.started.push(title); h.current = { state: 'recording' }; return this.status(); }
  },
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => {
      if (h.configThrows) throw h.configThrows;
      return { meeting: { calendarReminder: h.calendarReminder } };
    },
  }),
}));
vi.mock('../../../../src/host/services/infra/notificationService', () => ({
  notificationService: {
    notifyMeetingStarting: (d: { meetingTitle: string }) => {
      if (h.notifyThrows) return Promise.reject(h.notifyThrows);
      h.notified.push(d.meetingTitle);
    },
  },
}));

import { createMeetingIpc } from '../../../../src/host/ipc/desktopMeeting';

describe('desktopMeeting 会前提醒', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    h.warn.mockClear();
    Object.assign(h, {
      posts: [],
      status: 3,
      events: [],
      started: [],
      notified: [],
      current: null,
      bridgeAvailable: true,
      calendarReminder: true,
      configThrows: null,
      calendarAccessThrows: null,
      eventsThrows: null,
      notifyThrows: null,
    });
  });
  afterEach(() => { vi.useRealTimers(); Object.defineProperty(process, 'platform', platform); });

  it('快开始的会：系统通知 + 录制条；点「记这场会」用日程名做标题；巡检从不请求授权、从不开录', async () => {
    const startMeetingCapture = vi.fn(async () => ({ success: true }));
    const ipc = createMeetingIpc({ startMeetingCapture, stopManualAudio: vi.fn() });
    h.events = [{ id: 'ek-1', title: '产品评审', startMs: Date.now() + 60_000 }];
    await vi.advanceTimersByTimeAsync(MEETING_SESSION_LIMITS.CALENDAR_POLL_MS);
    expect(h.notified).toEqual(['产品评审']); // 原始标题，文案由通知服务按 ui.language 拼（meetingReminderNotification）
    expect(((await ipc.handlers.getMeetingStatus()).data as { upcoming: { title: string } }).upcoming.title).toBe('产品评审');
    expect(startMeetingCapture).not.toHaveBeenCalled(); // 只提醒，绝不自动开录
    expect(h.posts.every((p) => p === '/v1/passive/calendar' || p === '/v1/read/calendar-events')).toBe(true);
    expect(h.warn).not.toHaveBeenCalled();

    await ipc.handlers.startMeeting({}, undefined);
    expect(h.started).toEqual(['产品评审']);
    expect(((await ipc.handlers.getMeetingStatus()).data as { upcoming: unknown }).upcoming).toBeNull();
  });

  it('不是完全访问：不读日程、不提醒，记录 not_granted（带原始状态）且同因节流', async () => {
    h.status = 4;
    createMeetingIpc({ startMeetingCapture: vi.fn(), stopManualAudio: vi.fn() });
    h.events = [{ id: 'ek-1', title: '周会', startMs: Date.now() + 60_000 }];
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(MEETING_SESSION_LIMITS.CALENDAR_POLL_MS);
    }
    expect(h.posts).toEqual(Array(5).fill('/v1/passive/calendar'));
    expect(h.notified).toEqual([]);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith('[meeting-reminder] not_granted', { reason: 'not_granted', status: 'write_only' });
  });

  it('无原生桥（darwin）记录一次 no_bridge；非 darwin 保持静默', () => {
    h.bridgeAvailable = false;
    createMeetingIpc({ startMeetingCapture: vi.fn(), stopManualAudio: vi.fn() });
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith('[meeting-reminder] no_bridge', { reason: 'no_bridge', platform: 'darwin' });

    h.warn.mockClear();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    createMeetingIpc({ startMeetingCapture: vi.fn(), stopManualAudio: vi.fn() });
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('开关关闭保持静默；读取开关抛错记录 enabled_failed 且同因节流', async () => {
    h.calendarReminder = false;
    createMeetingIpc({ startMeetingCapture: vi.fn(), stopManualAudio: vi.fn() });
    await vi.advanceTimersByTimeAsync(MEETING_SESSION_LIMITS.CALENDAR_POLL_MS);
    expect(h.warn).not.toHaveBeenCalled();

    h.configThrows = new Error('config_store_corrupt');
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(MEETING_SESSION_LIMITS.CALENDAR_POLL_MS);
    }
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith('[meeting-reminder] enabled_failed', { reason: 'enabled_failed', error: 'config_store_corrupt' });
  });

  it('granted 抛错、upcoming 抛错、notify 拒绝各自可区分，且窗口内不同原因立即记录', async () => {
    createMeetingIpc({ startMeetingCapture: vi.fn(), stopManualAudio: vi.fn() });

    h.calendarAccessThrows = new Error('calendar_probe_boom');
    await vi.advanceTimersByTimeAsync(MEETING_SESSION_LIMITS.CALENDAR_POLL_MS);
    expect(h.warn).toHaveBeenCalledWith('[meeting-reminder] granted_failed', { reason: 'granted_failed', error: 'calendar_probe_boom' });

    h.calendarAccessThrows = null;
    h.eventsThrows = new Error('env_assist_bridge:bridge_http_503');
    await vi.advanceTimersByTimeAsync(MEETING_SESSION_LIMITS.CALENDAR_POLL_MS);
    expect(h.warn).toHaveBeenCalledWith('[meeting-reminder] upcoming_failed', { reason: 'upcoming_failed', error: 'env_assist_bridge:bridge_http_503' });

    h.eventsThrows = null;
    h.events = [{ id: 'ek-notify-fail', title: '架构评审', startMs: Date.now() + 60_000 }];
    h.notifyThrows = new Error('notification_center_unavailable');
    await vi.advanceTimersByTimeAsync(MEETING_SESSION_LIMITS.CALENDAR_POLL_MS);
    expect(h.warn).toHaveBeenCalledWith('[meeting-reminder] notify_failed', { reason: 'notify_failed', error: 'notification_center_unavailable' });
    expect(h.warn).toHaveBeenCalledTimes(3);
  });
});
