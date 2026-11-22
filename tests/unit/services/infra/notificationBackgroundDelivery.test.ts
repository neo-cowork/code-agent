import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fixture from '../../../../src-tauri/src/notification_click_fixtures/needs-input-click.json';
import { NEEDS_INPUT_NATIVE_FALLBACK, NOTIFICATION_BUDGET } from '../../../../src/shared/constants';
import { IPC_CHANNELS } from '../../../../src/shared/ipc';

vi.unmock('electron');

const nativeSend = vi.fn();
const broadcast = vi.fn();
let testDir: string;
let heldFile: string;
let detachBroadcast: () => void;
let bridge: typeof import('../../../../src/host/platform/windowBridge');
let platform: typeof import('../../../../src/host/platform/notifications');
let configService: typeof import('../../../../src/host/services/core/configService');
let quitIntent: typeof import('../../../../src/host/services/daemon/quitIntent');
let appWindow: InstanceType<typeof bridge.AppWindow> | undefined;
let notificationService: typeof import('../../../../src/host/services/infra/notificationService').notificationService;

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'notification-background-'));
  heldFile = join(testDir, NOTIFICATION_BUDGET.HELD_FILE_NAME);
  vi.stubEnv('CODE_AGENT_DATA_DIR', testDir);
  vi.resetModules();
  bridge = await import('../../../../src/host/platform/windowBridge');
  platform = await import('../../../../src/host/platform/notifications');
  configService = await import('../../../../src/host/services/core/configService');
  quitIntent = await import('../../../../src/host/services/daemon/quitIntent');
  ({ notificationService } = await import('../../../../src/host/services/infra/notificationService'));
});

beforeEach(async () => {
  vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '');
  vi.stubEnv('CODE_AGENT_SHELL_EXE', '');
  if (!platform.Notification.isSupported()) vi.spyOn(platform.Notification, 'isSupported').mockReturnValue(true);
  vi.useFakeTimers();
  vi.spyOn(console, 'error');
  notificationService.clearRecentNotifications();
  notificationService.setNativeNotificationSender(nativeSend);
  detachBroadcast = bridge.onRendererPush((channel, payload) => {
    if (channel === IPC_CHANNELS.NOTIFICATION_SHOW) broadcast(payload);
  });
  await setLanguage('en');
});

afterEach(() => {
  notificationService.clearRecentNotifications();
  notificationService.setNativeNotificationSender(null);
  detachBroadcast();
  appWindow?.destroy();
  appWindow = undefined;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(testDir, { recursive: true, force: true });
});

async function setLanguage(language: 'en' | 'zh'): Promise<void> {
  const config = configService.getConfigService();
  await config.updateSettings({ ui: { ...config.getSettings().ui, language } });
}

function finish(sessionId: string, sessionTitle: string, summary = 'The weekly report section is ready.'): void {
  notificationService.notifyTaskComplete({ sessionId, sessionTitle, summary, toolsUsed: [] }, { force: true });
}

function expectHeldSessions(...sessionIds: string[]): void {
  const held = JSON.parse(readFileSync(heldFile, 'utf8')) as { items: { sessionId: string }[] };
  expect(held.items.map((item) => item.sessionId)).toEqual(sessionIds);
}

it('warns no-window-not-background and only broadcasts when quit intent is none', () => {
  expect(quitIntent.getDaemonQuitIntent()).toBe('none');
  expect(bridge.hasInteractiveUi()).toBe(false);
  finish('weekly', 'Weekly report');
  expect(nativeSend).not.toHaveBeenCalled();
  expect(broadcast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 'weekly' }));
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('WARN [NotificationService] Notification has no interactive window'),
    expect.objectContaining({ reason: 'no-window-not-background', via: 'immediate' }),
  );
});

it('sends the single held completion natively at window-end and clears the held file', () => {
  appWindow = new bridge.AppWindow();
  finish('first', 'Weekly overview');
  finish('second', 'Customer support', '**The weekly report section is ready.**');
  expectHeldSessions('second');
  expect(nativeSend).not.toHaveBeenCalled();

  broadcast.mockClear();
  quitIntent.setDaemonQuitIntent('background');
  appWindow.close();
  vi.advanceTimersByTime(NOTIFICATION_BUDGET.WINDOW_MS);

  const last = notificationService.getRecentNotifications().at(-1);
  expect(nativeSend).toHaveBeenCalledExactlyOnceWith({
    title: 'Task completed - Customer support',
    body: 'The weekly report section is ready.',
    id: last?.id,
    sessionId: 'second',
  });
  expect(broadcast).not.toHaveBeenCalled();
  expect(existsSync(heldFile)).toBe(false);
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('Notification delivered natively'),
    expect.objectContaining({ reason: 'no-window-background', via: 'window-end', notificationId: last?.id }),
  );
});

it.each([
  ['en', '2 more notifications', 'Customer support', 'Product rollout'],
  ['zh', '另有 2 条通知', '客户支持', '产品上线'],
] as const)('sends a native digest with the latest session, clears the held file (%s)', async (language, title, second, third) => {
  await setLanguage(language);
  appWindow = new bridge.AppWindow();
  finish('first', second);
  finish('second', second);
  finish('third', third);
  expectHeldSessions('second', 'third');
  expect(nativeSend).not.toHaveBeenCalled();

  broadcast.mockClear();
  quitIntent.setDaemonQuitIntent('background');
  appWindow.close();
  vi.advanceTimersByTime(NOTIFICATION_BUDGET.WINDOW_MS);

  const digest = notificationService.getRecentNotifications().at(-1);
  expect(digest).toMatchObject({ type: 'digest', sessionId: '' });
  expect(nativeSend).toHaveBeenCalledExactlyOnceWith({
    title,
    body: expect.stringContaining(third),
    id: digest?.id,
    sessionId: 'third',
  });
  expect(broadcast).not.toHaveBeenCalled();
  expect(existsSync(heldFile)).toBe(false);
  const logs = vi.mocked(console.error).mock.calls;
  const foldedAt = logs.findIndex(([message]) => String(message).includes('Notification folded into digest'));
  const nativeAt = logs.findIndex(([message, fields]) => String(message).includes('Notification delivered natively')
    && (fields as { via?: string })?.via === 'digest');
  expect(foldedAt).toBeGreaterThanOrEqual(0);
  expect(nativeAt).toBeGreaterThan(foldedAt);
});

it('broadcasts only with an interactive window, including a digest with its original empty session', () => {
  quitIntent.setDaemonQuitIntent('background');
  appWindow = new bridge.AppWindow();
  expect(bridge.hasInteractiveUi()).toBe(true);
  finish('first', 'Weekly overview');
  finish('second', 'Customer support');
  finish('third', 'Product rollout');
  vi.advanceTimersByTime(NOTIFICATION_BUDGET.WINDOW_MS);

  expect(nativeSend).not.toHaveBeenCalled();
  expect(broadcast).toHaveBeenCalledTimes(2);
  expect(broadcast).toHaveBeenNthCalledWith(1, expect.objectContaining({ sessionId: 'first' }));
  expect(broadcast).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: '2 more notifications', sessionId: '' }));
});

it('leaves needs_input native delivery to its existing fallback, once per item', async () => {
  quitIntent.setDaemonQuitIntent('background');
  notificationService.notifyNeedsInput({ sessionId: 'approval-session', title: 'Approve edit', body: 'Approve a report edit' });
  expect(nativeSend).not.toHaveBeenCalled();
  expect(broadcast).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
  vi.useRealTimers();
  await vi.waitFor(() => expect(nativeSend).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sessionId: 'approval-session' }),
  ), { timeout: 5000 });
}, 10_000);

it('keeps background delivery silent in dry-run', () => {
  vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
  quitIntent.setDaemonQuitIntent('background');
  finish('weekly', 'Weekly report');
  expect(nativeSend).not.toHaveBeenCalled();
  expect(broadcast).not.toHaveBeenCalled();
  expect(notificationService.getRecentNotifications()).toEqual([expect.objectContaining({ delivery: 'dry_run' })]);
});

it.each([
  ['single', 'en', 'Task completed - Customer support'],
  ['digest', 'en', '2 more notifications'],
  ['digest', 'zh', '另有 2 条通知'],
] as const)('records notify-only shell argv after window-end (%s, %s)', async (kind, language, title) => {
  await setLanguage(language);
  if (process.platform !== 'darwin') vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const executable = join(testDir, 'record-notify-argv');
  const argvFile = join(testDir, 'notify-argv');
  rmSync(argvFile, { force: true });
  writeFileSync(executable, '#!/bin/sh\nprintf "%s\\0" "$@" > "$0.tmp"\nmv "$0.tmp" "$(dirname "$0")/notify-argv"\n', { mode: 0o700 });
  vi.stubEnv('CODE_AGENT_SHELL_EXE', executable);
  notificationService.setNativeNotificationSender(null);
  appWindow = new bridge.AppWindow();
  const second = language === 'zh' ? '客户支持' : 'Customer support';
  const third = language === 'zh' ? '产品上线' : 'Product rollout';
  const body = language === 'zh' ? '周报章节已整理好。' : 'The weekly report section is ready.';
  finish('first', second, body);
  finish('second', second, body);
  if (kind === 'digest') finish('third', third, body);
  quitIntent.setDaemonQuitIntent('background');
  appWindow.close();
  vi.advanceTimersByTime(NOTIFICATION_BUDGET.WINDOW_MS);
  vi.useRealTimers();

  const entry = notificationService.getRecentNotifications().at(-1);
  await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('Notification delivered natively'),
    expect.objectContaining({ reason: 'no-window-background', via: kind === 'single' ? 'window-end' : 'digest' }),
  ));
  const argv = readFileSync(argvFile, 'utf8').split('\0').slice(0, -1);
  expect(argv).toEqual(fixture.argv.map((arg, index) => {
    switch (fixture.argv[index - 1]) {
      case '--title': return title;
      case '--body': return kind === 'single' ? body : expect.stringContaining(third);
      case '--id': return entry?.id;
      case '--session': return kind === 'single' ? 'second' : 'third';
      default: return arg;
    }
  }));
  expect(argv.filter((_, index) => index > 0 && index % 2 === 0).every(Boolean)).toBe(true);
  console.info('Recorded notify-only argv', JSON.stringify(argv));
});
