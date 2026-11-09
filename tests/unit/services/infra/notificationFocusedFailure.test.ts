import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';
import { COMPANION_LIMITS } from '../../../../src/shared/constants/companion';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

// Keep the real web-mode live-window registry and renderer event bus.
vi.mock('../../../../src/host/platform', async () => ({
  ...await import('../../../../src/host/platform/windowBridge'),
  Notification: { isSupported: () => true },
}));
vi.mock('../../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: logs.info, warn: logs.warn, error: vi.fn() }),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));

let notificationService: typeof import('../../../../src/host/services/infra/notificationService').notificationService;
let desktopPresence: typeof import('../../../../src/host/services/companion/desktopPresence').desktopPresence;
let policy: typeof import('../../../../src/host/services/infra/notificationPolicy');
let window: InstanceType<typeof import('../../../../src/host/platform/windowBridge').AppWindow>;
const task = { sessionId: 's', sessionTitle: 'Weekly report', duration: 1, toolsUsed: [] };
const broadcastToRenderer = vi.fn();
let unsubscribe: () => void;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '');
  vi.clearAllMocks();
  ({ notificationService } = await import('../../../../src/host/services/infra/notificationService'));
  ({ desktopPresence } = await import('../../../../src/host/services/companion/desktopPresence'));
  policy = await import('../../../../src/host/services/infra/notificationPolicy');
  const { AppWindow, onRendererPush } = await import('../../../../src/host/platform');
  window = new AppWindow();
  expect(AppWindow.getAllWindows()).toEqual([window]);
  expect(AppWindow.getFocusedWindow()).toBe(window);
  unsubscribe = onRendererPush(broadcastToRenderer);
});

afterEach(async () => {
  unsubscribe();
  window.destroy();
  await notificationService.dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function reportFocus(focused: boolean, visible = true, lastInputAt = Date.now()): void {
  desktopPresence.report({ visible, focused, lastInputAt });
}

function expectSkip(reason: string): void {
  expect(broadcastToRenderer).not.toHaveBeenCalled();
  expect(logs.info).toHaveBeenCalledWith('Notification not delivered', expect.objectContaining({ reason }));
  expect(logs.info).not.toHaveBeenCalledWith('Notification dispatched to renderer', expect.anything());
  console.info('INFO Notification not delivered', { reason });
}

describe('ordinary completion with a real live AppWindow', () => {
  it('no report delivers with a warning', () => {
    notificationService.notifyTaskComplete(task);
    expect(broadcastToRenderer).toHaveBeenCalledWith(IPC_CHANNELS.NOTIFICATION_SHOW, expect.objectContaining({ sessionId: 's' }));
    expect(logs.warn).toHaveBeenCalledWith('Notification focus unknown', { reason: 'no fresh presence report' });
  });

  it('blurred report delivers despite the live window', () => {
    reportFocus(false);
    notificationService.notifyTaskComplete(task);
    expect(broadcastToRenderer).toHaveBeenCalledWith(IPC_CHANNELS.NOTIFICATION_SHOW, expect.objectContaining({ title: '任务完成 - Weekly report' }));
    expect(logs.info).toHaveBeenCalledWith('Notification dispatched to renderer', { sessionTitle: task.sessionTitle });
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('fresh foreground report skips with reason app-focused', () => {
    reportFocus(true);
    notificationService.notifyTaskComplete(task);
    expectSkip('app-focused');
  });

  it('focused with old input still skips (window focus is not user activity)', () => {
    reportFocus(true, true, Date.now() - COMPANION_LIMITS.desktopPresenceFreshMs - 1);
    notificationService.notifyTaskComplete(task);
    expectSkip('app-focused');
  });

  it('focused while viewing another session still skips', () => {
    desktopPresence.report({ visible: true, focused: true, lastInputAt: Date.now(), viewingSessionId: 'other' });
    notificationService.notifyTaskComplete(task);
    expectSkip('app-focused');
  });

  it('hidden focused report delivers', () => {
    reportFocus(true, false);
    notificationService.notifyTaskComplete(task);
    expect(broadcastToRenderer).toHaveBeenCalledOnce();
  });

  it('stale report delivers with a warning', () => {
    const staleAt = Date.now() - COMPANION_LIMITS.desktopPresenceFreshMs - 1;
    desktopPresence.report({ visible: true, focused: true, lastInputAt: staleAt }, staleAt);
    notificationService.notifyTaskComplete(task);
    expect(broadcastToRenderer).toHaveBeenCalledOnce();
    expect(logs.warn).toHaveBeenCalledWith('Notification focus unknown', { reason: 'no fresh presence report' });
  });

  it('notifications disabled skips with an info reason', () => {
    reportFocus(false);
    notificationService.setEnabled(false);
    notificationService.notifyTaskComplete(task);
    expectSkip('notifications-disabled');
  });

  it('intent blocked by policy skips with an info reason', () => {
    vi.spyOn(policy, 'evaluateNotificationPolicy').mockReturnValueOnce({ allowed: false, reason: 'blocked' });
    notificationService.notifyTaskComplete(task);
    expectSkip('intent-blocked-by-policy');
  });

  it('force still bypasses focus', () => {
    reportFocus(true);
    notificationService.notifyTaskComplete(task, { force: true });
    expect(broadcastToRenderer).toHaveBeenCalledOnce();
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('dry run still bypasses focus and only records', () => {
    reportFocus(true);
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
    notificationService.notifyTaskComplete(task);
    expect(broadcastToRenderer).not.toHaveBeenCalled();
    expect(notificationService.getRecentNotifications()).toEqual([expect.objectContaining({ delivery: 'dry_run' })]);
    expect(logs.warn).not.toHaveBeenCalled();
  });
});

describe('plugin uses the same focus gate', () => {
  it('skips while focused and delivers after blur', () => {
    reportFocus(true);
    notificationService.notifyPlugin({ title: 'Reminder', body: 'Weekly report ready' });
    expectSkip('app-focused');
    reportFocus(false);
    notificationService.notifyPlugin({ title: 'Reminder', body: 'Weekly report ready' });
    expect(broadcastToRenderer).toHaveBeenCalledOnce();
  });

  it('logs policy rejection', () => {
    vi.spyOn(policy, 'evaluateNotificationPolicy').mockReturnValueOnce({ allowed: false, reason: 'blocked' });
    notificationService.notifyPlugin({ title: 'Reminder', body: 'Weekly report ready' });
    expectSkip('intent-blocked-by-policy');
  });
});

describe('focus bypass and unread marking remain unchanged', () => {
  it('unforced failure bypasses focused window with urgent:true', () => {
    reportFocus(true);
    notificationService.notifyTaskComplete({ ...task, succeeded: false });
    expect(broadcastToRenderer).toHaveBeenCalledWith(IPC_CHANNELS.NOTIFICATION_SHOW, expect.objectContaining({ urgent: true, failure: true }));
  });

  it.each([true, false])('needs-input bypasses focused=%s with urgent:true', (focused) => {
    reportFocus(focused);
    notificationService.notifyNeedsInput({ sessionId: 's', title: 'Confirmation needed', body: 'Please review' });
    expect(broadcastToRenderer).toHaveBeenCalledWith(IPC_CHANNELS.NOTIFICATION_SHOW, expect.objectContaining({ sessionId: 's', urgent: true }));
  });

  it('failure and needs-input mark unread; ordinary completion does not', () => {
    reportFocus(false);
    notificationService.notifyTaskComplete({ ...task, succeeded: false });
    notificationService.notifyNeedsInput({ sessionId: 's', title: 'Confirmation needed', body: 'Please review' });
    notificationService.notifyTaskComplete(task);
    const payloads = broadcastToRenderer.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(payloads).toHaveLength(3);
    expect(payloads[0]).toMatchObject({ failure: true, markSessionUnread: true });
    expect(payloads[1]).toMatchObject({ urgent: true, markSessionUnread: true });
    expect(payloads[2].markSessionUnread).toBeUndefined();
  });
});
