import { beforeEach, describe, expect, it, vi } from 'vitest';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<object>(),
  createLogger: () => ({ warn: warnSpy, debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { MeetingCalendarReminder } from '../../../../src/host/services/desktop/meetingCalendar';
import { MEETING_SESSION_LIMITS as L } from '../../../../src/shared/constants';
import type { MeetingUpcoming } from '../../../../src/shared/contract/audioCapture';

const MIN = 60_000;

function setup(opts: { enabled?: boolean; granted?: boolean; events?: MeetingUpcoming[]; active?: boolean } = {}) {
  let now = 1_000_000;
  const deps = {
    enabled: vi.fn(() => opts.enabled ?? true),
    granted: vi.fn(async () => opts.granted ?? true),
    upcoming: vi.fn(async () => opts.events ?? []),
    isMeetingActive: () => opts.active ?? false,
    notify: vi.fn(),
    now: () => now,
  };
  return { r: new MeetingCalendarReminder(deps), deps, setNow: (ms: number) => { now = ms; } };
}

describe('会前提醒（只提醒，不自动开录）', () => {
  beforeEach(() => { warnSpy.mockClear(); });

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
    expect(await t.r.upcoming()).toEqual(ev);
    t.setNow(ev.startAtMs + L.CALENDAR_LEAD_MS);
    expect(await t.r.upcoming()).toBeNull();
  });

  it('关掉开关：录制条上的「快开始了」立刻收起，不等下一分钟巡检、更不挂到开会后', async () => {
    const ev = { id: 'ek-1', title: '产品周会', startAtMs: 1_000_000 + MIN };
    const t = setup({ events: [ev] });
    await t.r.tick();
    expect(await t.r.upcoming()).toEqual(ev);
    t.deps.enabled.mockReturnValue(false);
    expect(await t.r.upcoming()).toBeNull();
    t.deps.enabled.mockReturnValue(true); // 重新打开也不会把已收起的那条翻出来（同一场只提醒一次）
    expect(await t.r.upcoming()).toBeNull();
  });

  it('同名的两场会按 id 区分，各提醒一次', async () => {
    const t = setup();
    t.deps.upcoming.mockResolvedValueOnce([{ id: 'a', title: '站会', startAtMs: 1_060_000 }]);
    await t.r.tick();
    t.deps.upcoming.mockResolvedValueOnce([{ id: 'b', title: '站会', startAtMs: 1_060_000 }]);
    await t.r.tick();
    expect(t.deps.notify).toHaveBeenCalledTimes(2);
  });

  it('巡检中途失权：停止读日程、不提醒、不抛（不刷屏）', async () => {
    const t = setup({ events: [{ id: 'a', title: '周会', startAtMs: 1_060_000 }] });
    t.deps.granted.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) await expect(t.r.tick()).resolves.toBeUndefined();
    expect(t.deps.granted).toHaveBeenCalledTimes(5);
    expect(t.deps.upcoming).not.toHaveBeenCalled();
    expect(t.deps.notify).not.toHaveBeenCalled();
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
    expect(warnSpy).toHaveBeenCalledWith('[meeting-reminder] upcoming_failed', {
      reason: 'upcoming_failed',
      error: 'env_assist_bridge:bridge_http_403',
    });
  });

  it('同因在节流窗口内只记一次 warn，不同原因立即记，过窗口后再记', async () => {
    const t = setup();
    t.deps.granted.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) {
      await t.r.tick();
      t.setNow(1_000_000 + (i + 1) * MIN);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('[meeting-reminder] not_granted', { reason: 'not_granted' });

    // Different reason inside the same window logs immediately
    t.deps.granted.mockRejectedValueOnce(new Error('probe_boom'));
    await t.r.tick();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenLastCalledWith('[meeting-reminder] granted_failed', { reason: 'granted_failed', error: 'probe_boom' });

    // After throttle window passes, same reason logs again
    t.setNow(1_000_000 + L.CALENDAR_WARN_THROTTLE_MS);
    await t.r.tick();
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('enabled 抛错不逃逸 tick，且记 enabled_failed', async () => {
    const t = setup();
    t.deps.enabled.mockImplementation(() => { throw new Error('cfg_read_err'); });
    await expect(t.r.tick()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('[meeting-reminder] enabled_failed', { reason: 'enabled_failed', error: 'cfg_read_err' });
  });
});
