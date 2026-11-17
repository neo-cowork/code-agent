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
}));

vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<object>(), createLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/host/permissions/envAssist/shellBridge/client', () => ({
  resolveShellBridgeClientFromEnv: () => ({
    post: async (path: string) => {
      h.posts.push(path);
      if (path === '/v1/passive/calendar') return { status: h.status };
      if (path === '/v1/read/calendar-events') return { events: h.events };
      throw new Error(`unexpected ${path}`);
    },
  }),
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
  getConfigService: () => ({ getSettings: () => ({ meeting: { calendarReminder: true } }) }),
}));
vi.mock('../../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyMeetingStarting: (d: { meetingTitle: string }) => { h.notified.push(d.meetingTitle); } },
}));

import { createMeetingIpc } from '../../../../src/host/ipc/desktopMeeting';

describe('desktopMeeting 会前提醒', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.assign(h, { posts: [], status: 3, events: [], started: [], notified: [], current: null });
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

    await ipc.handlers.startMeeting({}, undefined);
    expect(h.started).toEqual(['产品评审']);
    expect(((await ipc.handlers.getMeetingStatus()).data as { upcoming: unknown }).upcoming).toBeNull();
  });

  it('不是完全访问：不读日程、不提醒', async () => {
    h.status = 4;
    createMeetingIpc({ startMeetingCapture: vi.fn(), stopManualAudio: vi.fn() });
    h.events = [{ id: 'ek-1', title: '周会', startMs: Date.now() + 60_000 }];
    await vi.advanceTimersByTimeAsync(MEETING_SESSION_LIMITS.CALENDAR_POLL_MS);
    expect(h.posts).toEqual(['/v1/passive/calendar']);
    expect(h.notified).toEqual([]);
  });
});
