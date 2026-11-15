// Evidence class: hermetic-protocol (fake native bridges). Real EventKit dialog is the real-device step (验收⑤).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calendarAccess } from '../../../../../src/host/permissions/envAssist/probes/passiveProbes';
import { createShellPassiveBridge } from '../../../../../src/host/permissions/envAssist/probes/shellPassiveBridge';
import { createShellPromptingBridge } from '../../../../../src/host/permissions/envAssist/grants/shellPromptingBridge';
import { mintClickToken, requestGrant } from '../../../../../src/host/permissions/envAssist/grants/requestGrant';
import { createCalendarEventsReader } from '../../../../../src/host/permissions/envAssist/calendarEvents';
import { resetPendingCalendarEnable } from '../../../../../src/host/permissions/envAssist/calendarSetting';
import type { PassiveBridge, PromptingBridge } from '../../../../../src/host/permissions/envAssist/probes/types';
import { registerEnvAssistHandlers } from '../../../../../src/host/ipc/envAssist.ipc';
import { ipcHost, type HandlerFn } from '../../../../../src/host/platform';
import { ENV_ASSIST_CALENDAR_CONFIRM_MS, ENV_ASSIST_CALENDAR_POLL_MS } from '../../../../../src/shared/constants/envAssist';

vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<object>(), createLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

type Status = 0 | 1 | 2 | 3 | 4;

/** One fake EventKit: `answer` is what the user picks in the dialog, applied after `answerAfterPolls` passive reads. */
class FakeEventKit {
  status: Status = 0;
  answer: Status | null = null;
  answerAfterPolls = 2;
  passiveReads = 0;
  prompts = 0;
  passive = { EKAuthorizationStatusForEvents: async () => {
    this.passiveReads++;
    if (this.prompts > 0 && this.answer !== null && this.passiveReads > this.answerAfterPolls) this.status = this.answer;
    return this.status;
  } } as unknown as PassiveBridge;
  grant = { requestFullAccessToEvents: async () => { this.prompts++; } } as unknown as PromptingBridge;
}

describe('calendarAccess: EKAuthorizationStatus → access (macOS 14+)', () => {
  it.each([[0, 'undecided'], [1, 'restricted'], [2, 'denied'], [3, 'granted'], [4, 'write_only']] as const)('status %i → %s', async (code, want) => {
    expect(await calendarAccess({ EKAuthorizationStatusForEvents: async () => code } as unknown as PassiveBridge)).toBe(want);
  });
  it('no bridge / native error → unavailable', async () => {
    expect(await calendarAccess(null)).toBe('unavailable');
    expect(await calendarAccess({ EKAuthorizationStatusForEvents: async () => { throw new Error('x'); } } as unknown as PassiveBridge)).toBe('unavailable');
  });
});

describe('shell bridges: calendar routes', () => {
  it('passive / grant / read hit the three native routes, and only those', async () => {
    const post = vi.fn(async (path: string) => (path === '/v1/passive/calendar' ? { status: 4 }
      : path === '/v1/grant/calendar' ? { requested: true }
      : { events: [{ id: 'e1', title: '周会', startMs: 5 }, { title: 'no id', startMs: 6 }] }));
    const client = { post } as never;
    expect(await createShellPassiveBridge(client).EKAuthorizationStatusForEvents()).toBe(4);
    await createShellPromptingBridge(client).requestFullAccessToEvents();
    expect(await createCalendarEventsReader(client)(1, 2)).toEqual([{ id: 'e1', title: '周会', startAtMs: 5 }]);
    expect(post.mock.calls).toEqual([['/v1/passive/calendar'], ['/v1/grant/calendar'], ['/v1/read/calendar-events', { fromMs: 1, toMs: 2 }]]);
  });
  it('malformed native answers throw instead of guessing', async () => {
    const client = { post: async () => ({ status: 9 }) } as never;
    await expect(createShellPassiveBridge(client).EKAuthorizationStatusForEvents()).rejects.toThrow('invalid_passive_calendar');
    await expect(createCalendarEventsReader({ post: async () => ({}) } as never)(1, 2)).rejects.toThrow('invalid_read_calendar');
  });
});

describe('requestGrant(calendars)', () => {
  it('一次点击凭证只弹一次框，过期凭证不弹', async () => {
    const kit = new FakeEventKit();
    const token = mintClickToken('setting:meetingCalendarReminder', () => 0);
    expect(await requestGrant(token, { pane: 'calendars' }, kit.grant, () => 1)).toBe('requested');
    expect(await requestGrant(token, { pane: 'calendars' }, kit.grant, () => 2)).toBe('rejected');
    expect(await requestGrant(mintClickToken('x', () => 0), { pane: 'calendars' }, kit.grant, () => 10 ** 9)).toBe('rejected');
    expect(kit.prompts).toBe(1);
  });
});

describe('envAssist enableSettingGrant / recheckSettingGrant (验收②)', () => {
  let handler: HandlerFn | undefined;
  let setting = false;
  let clock = 0;
  const open = vi.fn(async () => true);
  const write = vi.fn(async (on: boolean) => { setting = on; });
  beforeEach(() => {
    vi.spyOn(ipcHost, 'handle').mockImplementation((_c, fn) => { handler = fn; });
    setting = false; clock = 0; resetPendingCalendarEnable();
  });
  afterEach(() => { vi.restoreAllMocks(); open.mockClear(); write.mockClear(); });

  const install = (kit: FakeEventKit) => {
    registerEnvAssistHandlers({
      available: () => true, open, findNotice: async () => undefined,
      passiveBridge: kit.passive, grantBridge: kit.grant,
      calendarReminderSetting: { read: () => setting, write },
      now: () => clock, sleep: async (ms) => { clock += ms; },
    });
    return async (action: string, payload: unknown = { setting: 'meetingCalendarReminder' }) =>
      ((await handler!({} as never, { action, payload })) as { data: unknown }).data;
  };

  it('undecided + 点击：弹一次框，被动探针确认「允许」后由宿主写开', async () => {
    const kit = new FakeEventKit(); kit.answer = 3;
    const call = install(kit);
    expect(await call('enableSettingGrant')).toEqual({ on: true });
    expect(kit.prompts).toBe(1);
    expect(write).toHaveBeenCalledWith(true);
    expect(setting).toBe(true);
  });

  it.each([[2, 'denied', true], [4, 'write_only', true], [1, 'restricted', false]] as const)(
    '已是 status %i：不弹框、不写开，reason=%s，opened=%s', async (status, reason, opened) => {
      const kit = new FakeEventKit(); kit.status = status;
      const call = install(kit);
      expect(await call('enableSettingGrant')).toEqual({ on: false, reason, ...(opened ? { opened: true } : {}) });
      expect(kit.prompts).toBe(0);
      expect(write).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(opened ? 1 : 0);
      if (opened) expect(open).toHaveBeenCalledWith('calendars');
    });

  it('在框里点「不允许」：退回关并打开「隐私与安全性 → 日历」', async () => {
    const kit = new FakeEventKit(); kit.answer = 2;
    const call = install(kit);
    expect(await call('enableSettingGrant')).toEqual({ on: false, reason: 'denied', opened: true });
    expect(kit.prompts).toBe(1);
    expect(write).not.toHaveBeenCalled();
  });

  it('已完全访问：不弹框直接写开', async () => {
    const kit = new FakeEventKit(); kit.status = 3;
    expect(await install(kit)('enableSettingGrant')).toEqual({ on: true });
    expect(kit.prompts).toBe(0);
  });

  it('白名单外的设置项被拒，零原生调用', async () => {
    const kit = new FakeEventKit();
    const call = install(kit);
    for (const payload of [{ setting: 'other' }, {}, { setting: 'meetingCalendarReminder', on: true }]) {
      expect(await call('enableSettingGrant', payload)).toEqual({ on: false, reason: 'unavailable' });
      expect(await call('recheckSettingGrant', payload)).toEqual({ on: false, reason: 'unavailable' });
    }
    expect(kit.passiveReads + kit.prompts).toBe(0);
  });

  it('A：60 秒窗口过后才点「允许」→ 停在关；之后复查（设置页/聚焦）补成开，且复查从不弹框', async () => {
    const kit = new FakeEventKit(); kit.answer = null;
    const call = install(kit);
    expect(await call('enableSettingGrant')).toEqual({ on: false, reason: 'undecided' });
    expect(kit.passiveReads).toBe(1 + ENV_ASSIST_CALENDAR_CONFIRM_MS / ENV_ASSIST_CALENDAR_POLL_MS);
    expect(setting).toBe(false);
    expect(await call('recheckSettingGrant')).toEqual({ on: false }); // 还没作答
    kit.status = 3; // 用户后来点了允许
    expect(await call('recheckSettingGrant')).toEqual({ on: true });
    expect(setting).toBe(true);
    expect(kit.prompts).toBe(1);
  });

  it('A：从没发起过开启请求的，即使已是完全访问，复查也不自动开', async () => {
    const kit = new FakeEventKit(); kit.status = 3;
    expect(await install(kit)('recheckSettingGrant')).toEqual({ on: false });
    expect(write).not.toHaveBeenCalled();
    expect(kit.prompts).toBe(0);
  });

  it('A：未完成的请求后来被拒，复查清掉它，再变成完全访问也不补开', async () => {
    const kit = new FakeEventKit();
    const call = install(kit);
    await call('enableSettingGrant');
    kit.status = 2;
    expect(await call('recheckSettingGrant')).toEqual({ on: false, reason: 'denied' });
    kit.status = 3;
    expect(await call('recheckSettingGrant')).toEqual({ on: false });
    expect(write).not.toHaveBeenCalled();
  });

  it('没有原生桥（web 构建）：不弹框，reason=unavailable', async () => {
    registerEnvAssistHandlers({
      available: () => false, open, findNotice: async () => undefined, passiveBridge: null, grantBridge: null,
      calendarReminderSetting: { read: () => setting, write },
    });
    const res = (await handler!({} as never, { action: 'enableSettingGrant', payload: { setting: 'meetingCalendarReminder' } })) as { data: unknown };
    expect(res.data).toEqual({ on: false, reason: 'unavailable' });
    expect(write).not.toHaveBeenCalled();
  });
});
