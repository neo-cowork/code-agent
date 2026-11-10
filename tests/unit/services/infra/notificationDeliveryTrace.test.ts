import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';
import { NOTIFICATION_BUDGET } from '../../../../src/shared/constants';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../../../src/host/platform', () => ({
  Notification: { isSupported: () => true },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer: mocks.broadcast,
}));
vi.mock('../../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mocks.info, warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));

let notificationService: typeof import('../../../../src/host/services/infra/notificationService').notificationService;

const task = (id: string) => ({ sessionId: id, sessionTitle: `T-${id}`, duration: 1000, toolsUsed: [] }) as never;
const infoCalls = (msg: string) => mocks.info.mock.calls.filter((c) => c[0] === msg);

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  ({ notificationService } = await import('../../../../src/host/services/infra/notificationService'));
  mocks.broadcast.mockClear();
  mocks.info.mockClear();
  notificationService.clearRecentNotifications();
});

afterEach(async () => {
  await notificationService.dispose();
  vi.useRealTimers();
});

describe('通知未送达/折叠的日志留痕', () => {
  it('needs-input 重复 dedupeKey：info 级 dedupe-duplicate', () => {
    const data = { sessionId: 's', title: 't', body: 'b', dedupeKey: 'dk-trace' };
    notificationService.notifyNeedsInput(data);
    notificationService.notifyNeedsInput(data);
    expect(infoCalls('Notification not delivered')).toEqual([
      ['Notification not delivered', { reason: 'dedupe-duplicate', dedupeKey: 'dk-trace' }],
    ]);
  });

  it('预算窗口内第二条被 held：budget-held，且不再记 dispatched', () => {
    notificationService.notifyTaskComplete(task('a'));
    expect(infoCalls('Notification dispatched to renderer')).toHaveLength(1);
    notificationService.notifyTaskComplete(task('b'));
    expect(infoCalls('Notification dispatched to renderer')).toHaveLength(1);
    expect(infoCalls('Notification held by budget')).toEqual([
      ['Notification held by budget', expect.objectContaining({ reason: 'budget-held', notificationId: expect.any(String), intent: 'task_complete', sessionId: 'b', windowRemainingMs: expect.any(Number), heldCount: expect.any(Number), note: 'folded by budget, not delivered individually' })],
    ]);
  });

  it('窗尾 ≥2 条折成摘要：budget-digest 带 count', () => {
    notificationService.notifyTaskComplete(task('a'));
    notificationService.notifyTaskComplete(task('b'));
    notificationService.notifyTaskComplete(task('c'));
    vi.runOnlyPendingTimers();
    expect(infoCalls('Notification folded into digest')).toEqual([
      ['Notification folded into digest', expect.objectContaining({ reason: 'budget-digest', count: 2, digestNotificationId: expect.any(String), heldNotificationIds: expect.arrayContaining([expect.any(String), expect.any(String)]) })],
    ]);
    vi.clearAllTimers();
  });

  it('同一名称定时任务 15 分钟窗内三次完成（+0s/+42s/+112s）：首条投递，后两条暂存不广播，窗尾合为 count=2 摘要；task_failed 绕过预算对比', async () => {
    const sessionTitle = '[定时] 回复四个字：定时完成';
    vi.setSystemTime(new Date('2026-11-07T07:46:25.425Z'));

    // +0s: completion #1
    notificationService.notifyTaskComplete(
      { sessionId: 'run-1', sessionTitle, duration: 1000, toolsUsed: [] },
      { force: true },
    );
    expect(mocks.info.mock.calls).toEqual([
      ['Notification dispatched to renderer', expect.objectContaining({ notificationId: expect.any(String), intent: 'task_complete', type: 'task_complete', sessionId: 'run-1', title: `任务完成 - ${sessionTitle}`, via: 'immediate' })],
    ]);
    expect(mocks.broadcast.mock.calls).toHaveLength(1);
    expect(mocks.broadcast.mock.calls[0][0]).toBe(IPC_CHANNELS.NOTIFICATION_SHOW);
    expect(mocks.broadcast.mock.calls[0][1]).toMatchObject({
      sessionId: 'run-1',
      title: `任务完成 - ${sessionTitle}`,
    });

    // +42s (07:47:07.431Z): completion #2
    vi.advanceTimersByTime(42_006);
    notificationService.notifyTaskComplete(
      { sessionId: 'run-2', sessionTitle, duration: 1000, toolsUsed: [] },
      { force: true },
    );
    expect(infoCalls('Notification dispatched to renderer')).toHaveLength(1);
    expect(mocks.broadcast.mock.calls).toHaveLength(1);
    expect(infoCalls('Notification held by budget')).toEqual([
      ['Notification held by budget', expect.objectContaining({ reason: 'budget-held', notificationId: expect.any(String), intent: 'task_complete', sessionId: 'run-2', windowRemainingMs: expect.any(Number), heldCount: expect.any(Number), note: 'folded by budget, not delivered individually' })],
    ]);

    // +112s (07:48:17.369Z, +69.938s from #2): completion #3
    vi.advanceTimersByTime(69_938);
    notificationService.notifyTaskComplete(
      { sessionId: 'run-3', sessionTitle, duration: 1000, toolsUsed: [] },
      { force: true },
    );
    expect(infoCalls('Notification dispatched to renderer')).toHaveLength(1);
    expect(mocks.broadcast.mock.calls).toHaveLength(1);
    expect(infoCalls('Notification held by budget')).toEqual([
      ['Notification held by budget', expect.objectContaining({ reason: 'budget-held', notificationId: expect.any(String), intent: 'task_complete', sessionId: 'run-2', windowRemainingMs: expect.any(Number), heldCount: expect.any(Number), note: 'folded by budget, not delivered individually' })],
      ['Notification held by budget', expect.objectContaining({ reason: 'budget-held', notificationId: expect.any(String), intent: 'task_complete', sessionId: 'run-3', windowRemainingMs: expect.any(Number), heldCount: expect.any(Number), note: 'folded by budget, not delivered individually' })],
    ]);

    // Advance past remaining window to reach +15m (08:01:25.425Z)
    vi.advanceTimersByTime(NOTIFICATION_BUDGET.WINDOW_MS - 42_006 - 69_938);
    expect(infoCalls('Notification folded into digest')).toEqual([
      ['Notification folded into digest', expect.objectContaining({ reason: 'budget-digest', count: 2, digestNotificationId: expect.any(String), heldNotificationIds: expect.arrayContaining([expect.any(String), expect.any(String)]) })],
    ]);
    expect(mocks.broadcast.mock.calls).toHaveLength(2);
    expect(mocks.broadcast.mock.calls[1][0]).toBe(IPC_CHANNELS.NOTIFICATION_SHOW);
    expect(mocks.broadcast.mock.calls[1][1]).toMatchObject({
      sessionId: '',
      title: '另有 2 条通知',
      body: '共 2 条通知： 任务完成 - [定时] 回复四个字：定时完成 任务完成 - [定时] 回复四个字：定时完成 …',
    });
    vi.clearAllTimers();

    // Contrast: task_failed bypasses the budget and delivers all three immediately
    mocks.broadcast.mockClear();
    mocks.info.mockClear();
    notificationService.clearRecentNotifications();

    for (const [id, deltaMs] of [['fail-1', 0], ['fail-2', 42_006], ['fail-3', 69_938]] as const) {
      if (deltaMs > 0) vi.advanceTimersByTime(deltaMs);
      notificationService.notifyTaskComplete(
        { sessionId: id, sessionTitle, duration: 1000, toolsUsed: [], succeeded: false },
        { force: true },
      );
    }
    expect(infoCalls('Notification dispatched to renderer')).toHaveLength(3);
    expect(infoCalls('Notification held by budget')).toHaveLength(0);
    expect(mocks.broadcast.mock.calls).toHaveLength(3);

    // dispose() inside the window logs each dropped item
    mocks.broadcast.mockClear();
    mocks.info.mockClear();
    notificationService.clearRecentNotifications();
    vi.setSystemTime(new Date('2026-11-07T07:46:25.425Z'));
    notificationService.notifyTaskComplete(
      { sessionId: 'run-1', sessionTitle, duration: 1000, toolsUsed: [] },
      { force: true },
    );
    vi.advanceTimersByTime(42_006);
    notificationService.notifyTaskComplete(
      { sessionId: 'run-2', sessionTitle, duration: 1000, toolsUsed: [] },
      { force: true },
    );
    vi.advanceTimersByTime(69_938);
    notificationService.notifyTaskComplete(
      { sessionId: 'run-3', sessionTitle, duration: 1000, toolsUsed: [] },
      { force: true },
    );
    expect(infoCalls('Notification held by budget')).toHaveLength(2);
    // Simulate app quit/restart before window end (e.g. at 08:02:49 or inside the 15m window)
    await notificationService.dispose();
    vi.advanceTimersByTime(NOTIFICATION_BUDGET.WINDOW_MS);
    expect(infoCalls('Notification folded into digest')).toHaveLength(0);
    expect(mocks.broadcast.mock.calls).toHaveLength(1);
    expect(infoCalls('Notification dropped')).toHaveLength(2);
  });
});

// The IDs come from the production singleton's logs and renderer payloads, never a budget stand-in.
describe('budget terminal trace through notifyTaskComplete', () => {
  it.each(['digest', 'clear', 'dispose'] as const)('three completions each have exactly one terminal record: %s', async (ending) => {
    vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
    for (const id of ['first', 'second', 'third']) {
      notificationService.notifyTaskComplete(task(id), { force: true });
      vi.advanceTimersByTime(1000);
    }
    const held = infoCalls('Notification held by budget').map((call) => call[1]);
    expect(held).toHaveLength(2);
    held.forEach((entry, index) => expect(entry).toEqual({
      reason: 'budget-held', notificationId: expect.stringMatching(/^notification_/),
      intent: 'task_complete', sessionId: ['second', 'third'][index],
      windowRemainingMs: NOTIFICATION_BUDGET.WINDOW_MS - (index + 1) * 1000,
      heldCount: index + 1, note: 'folded by budget, not delivered individually',
    }));
    const firstId = mocks.broadcast.mock.calls[0][1].id;
    const ids = [firstId, ...held.map((entry) => entry.notificationId)];
    expect(new Set(ids).size).toBe(3);
    expect(mocks.broadcast).toHaveBeenCalledTimes(1); // held items never reach reportClientDelivery
    expect(notificationService.getRecentNotifications().map((entry) => entry.id)).toEqual([firstId]);
    if (ending === 'digest') vi.advanceTimersByTime(NOTIFICATION_BUDGET.WINDOW_MS);
    else if (ending === 'clear') notificationService.clearRecentNotifications();
    else await notificationService.dispose();
    vi.advanceTimersByTime(NOTIFICATION_BUDGET.WINDOW_MS * 2);
    const dispatched = infoCalls('Notification dispatched to renderer').map((call) => call[1]);
    const digests = infoCalls('Notification folded into digest').map((call) => call[1]);
    const dropped = infoCalls('Notification dropped').map((call) => call[1]);
    for (const id of ids) {
      const terminalCount = dispatched.filter((entry) => entry.notificationId === id).length
        + digests.filter((entry) => entry.heldNotificationIds.includes(id)).length
        + dropped.filter((entry) => entry.notificationId === id).length;
      expect(terminalCount, `terminal record for ${id}`).toBe(1);
    }
    expect(dispatched[0]).toEqual({
      notificationId: firstId, intent: 'task_complete', type: 'task_complete',
      sessionId: 'first', title: '任务完成 - T-first', via: 'immediate',
    });
    if (ending === 'digest') {
      expect(digests).toEqual([{
        reason: 'budget-digest', count: 2, digestNotificationId: dispatched[1].notificationId,
        heldNotificationIds: ids.slice(1),
      }]);
      expect(dispatched[1]).toMatchObject({ type: 'digest', via: 'digest' });
      expect(notificationService.getRecentNotifications().map((entry) => entry.id))
        .toEqual(mocks.broadcast.mock.calls.map((call) => call[1].id));
      expect(dropped).toEqual([]);
    } else {
      expect(digests).toEqual([]);
      expect(dropped).toEqual(ids.slice(1).map((notificationId) => ({
        notificationId, reason: ending === 'clear' ? 'budget-cleared' : 'service-disposed',
      })));
      expect(mocks.broadcast).toHaveBeenCalledTimes(1);
    }
    for (const [message, fields] of mocks.info.mock.calls) console.info(message, JSON.stringify(fields));
  });

  it('one held completion is dispatched at window-end with the original id', () => {
    notificationService.notifyTaskComplete(task('first'), { force: true });
    notificationService.notifyTaskComplete(task('second'), { force: true });
    const id = infoCalls('Notification held by budget')[0][1].notificationId;
    vi.advanceTimersByTime(NOTIFICATION_BUDGET.WINDOW_MS);
    expect(infoCalls('Notification dispatched to renderer')[1]).toEqual([
      'Notification dispatched to renderer', {
        notificationId: id, intent: 'task_complete', type: 'task_complete',
        sessionId: 'second', title: '任务完成 - T-second', via: 'window-end',
      },
    ]);
    expect(mocks.broadcast.mock.calls[1][1].id).toBe(id);
    expect(notificationService.getRecentNotifications()[1].id).toBe(id);
    console.info(...infoCalls('Notification dispatched to renderer')[1]);
  });

  it.each(['resume', 'plugin', 'voice'] as const)('sent log is absent when %s is held', (kind) => {
    notificationService.notifyTaskComplete(task('first'), { force: true });
    if (kind === 'resume') notificationService.notifyTaskResuming({ sessionId: 'resume', sessionTitle: 'Resume', autoResumeCount: 1 });
    else if (kind === 'plugin') notificationService.notifyPlugin({ title: 'Plugin', body: 'Result' });
    else notificationService.notifyVoiceWorkSettled({ sessionId: 'voice', taskTitle: 'Voice', status: 'done' });
    expect(infoCalls('Notification held by budget')).toHaveLength(1);
    expect(mocks.info.mock.calls.filter(([message]) => /notification sent$/.test(message))).toEqual([]);
  });
});
