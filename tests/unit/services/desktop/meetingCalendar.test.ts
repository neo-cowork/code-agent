import { describe, expect, it, vi } from 'vitest';
import { MeetingCalendarReminder } from '../../../../src/host/services/desktop/meetingCalendar';
import { MEETING_SESSION_LIMITS as L } from '../../../../src/shared/constants';
import type { MeetingUpcoming } from '../../../../src/shared/contract/audioCapture';

const MIN = 60_000;

function setup(opts: { enabled?: boolean; granted?: boolean; events?: MeetingUpcoming[]; active?: boolean } = {}) {
  let now = 1_000_000;
  const deps = {
    enabled: () => opts.enabled ?? true,
    granted: vi.fn(async () => opts.granted ?? true),
    upcoming: vi.fn(async () => opts.events ?? []),
    isMeetingActive: () => opts.active ?? false,
    notify: vi.fn(),
    now: () => now,
  };
  return { r: new MeetingCalendarReminder(deps), deps, setNow: (ms: number) => { now = ms; } };
}

describe('会前提醒（只提醒，不自动开录）', () => {
  it('开关关着：不读授权、不读日历、不提醒', async () => {
    const t = setup({ enabled: false, events: [{ id: 'a', title: '周会', startAtMs: 1_060_000 }] });
    await t.r.tick();
    expect(t.deps.granted).not.toHaveBeenCalled();
    expect(t.deps.upcoming).not.toHaveBeenCalled();
    expect(t.deps.notify).not.toHaveBeenCalled();
  });

  it('没拿到日历完全访问：不读日程、不提醒', async () => {
    const t = setup({ granted: false, events: [{ id: 'a', title: '周会', startAtMs: 1_060_000 }] });
    await t.r.tick();
    expect(t.deps.upcoming).not.toHaveBeenCalled();
    expect(t.deps.notify).not.toHaveBeenCalled();
  });

  it('会快开始：提醒一次，同一场（按日程 id）不重复；录制条挂着提示，开始后 2 分钟自动收起', async () => {
    const ev = { id: 'ek-1', title: '产品周会', startAtMs: 1_000_000 + MIN };
    const t = setup({ events: [ev] });
    await t.r.tick();
    await t.r.tick();
    expect(t.deps.notify).toHaveBeenCalledTimes(1);
    expect(t.deps.notify).toHaveBeenCalledWith(ev);
    expect(t.deps.upcoming).toHaveBeenCalledWith(1_000_000, 1_000_000 + L.CALENDAR_LEAD_MS);
    expect(t.r.upcoming()).toEqual(ev);
    t.setNow(ev.startAtMs + L.CALENDAR_LEAD_MS);
    expect(t.r.upcoming()).toBeNull();
  });

  it('同名的两场会按 id 区分，各提醒一次', async () => {
    const t = setup();
    t.deps.upcoming.mockResolvedValueOnce([{ id: 'a', title: '站会', startAtMs: 1_060_000 }]);
    await t.r.tick();
    t.deps.upcoming.mockResolvedValueOnce([{ id: 'b', title: '站会', startAtMs: 1_060_000 }]);
    await t.r.tick();
    expect(t.deps.notify).toHaveBeenCalledTimes(2);
  });

  it('已经在记录：不提醒', async () => {
    const t = setup({ active: true, events: [{ id: 'a', title: '周会', startAtMs: 1_060_000 }] });
    await t.r.tick();
    expect(t.deps.notify).not.toHaveBeenCalled();
  });

  it('读日历出错：这一轮安静跳过，不抛', async () => {
    const t = setup();
    t.deps.upcoming.mockRejectedValueOnce(new Error('env_assist_bridge:bridge_http_403'));
    await expect(t.r.tick()).resolves.toBeUndefined();
    expect(t.deps.notify).not.toHaveBeenCalled();
  });
});
