import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ spawn: vi.fn(), warn: vi.fn(), broadcast: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: h.spawn,
}));
vi.mock('../../../../src/host/platform', async () => ({
  ...await import('../../../../src/host/platform/notifications'),
  broadcastToRenderer: h.broadcast,
}));
vi.mock('../../../../src/host/services/serviceRegistry', () => ({ getServiceRegistry: () => ({ register: vi.fn() }) }));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: h.warn, error: vi.fn() }),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));
vi.mock('../../../../src/host/services/infra/notificationHeldStore', () => ({ readHeldFile: () => [], writeHeldFile: vi.fn() }));
vi.mock('../../../../src/host/services/daemon/quitIntent', () => ({ getDaemonQuitIntent: () => 'background' }));

import { notificationService } from '../../../../src/host/services/infra/notificationService';
import { Notification } from '../../../../src/host/platform/notifications';

let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };
let osascript: ReturnType<typeof vi.spyOn>;
const notify = () => notificationService.notifyNeedsInput({ sessionId: '--session;$(ignored)', title: 'write_file', body: 'mcp__internal' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '');
  vi.stubEnv('CODE_AGENT_SHELL_EXE', '/Applications/Agent Neo.app/Contents/MacOS/code-agent-tauri');
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  osascript = vi.spyOn(Notification.prototype, 'show').mockImplementation(() => {});
  child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  h.spawn.mockReturnValue(child);
  notificationService.clearRecentNotifications();
  notificationService.setNativeNotificationSender(null);
});
afterEach(() => {
  expect(osascript).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('production notificationService needs-input background notify-only', () => {
  it('spawns argv --notify-only with title/body/id/session; never invokes platform osascript sender', () => {
    notify();
    const id = h.broadcast.mock.calls[0][1].id;
    expect(h.spawn).toHaveBeenCalledExactlyOnceWith(
      process.env.CODE_AGENT_SHELL_EXE,
      ['--notify-only', '--title', '有事项需要你确认', '--body', '后台任务在等你确认，打开 Agent Neo 处理。', '--id', id, '--session', '--session;$(ignored)'],
      { detached: true, stdio: 'ignore', shell: false },
    );
    expect(child.unref).toHaveBeenCalledOnce();
    expect(osascript).not.toHaveBeenCalled();
    console.info('ASSERT spawn argv:', JSON.stringify(h.spawn.mock.calls[0]));
    console.info('ASSERT src/host/platform/notifications.ts Notification.show (osascript) calls:', osascript.mock.calls.length);
  });

  it('missing env warns notify-only-executable-missing with no osascript', () => {
    vi.stubEnv('CODE_AGENT_SHELL_EXE', '');
    notify();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith('Native needs-input notification unavailable', { reason: 'notify-only-executable-missing' });
    console.info('ASSERT warn reason: notify-only-executable-missing');
  });

  it('spawn throwing warns notify-only-spawn-threw with no osascript', () => {
    h.spawn.mockImplementationOnce(() => { throw new Error('injected launch failure'); });
    notify();
    expect(h.warn).toHaveBeenCalledWith('Native needs-input notification failed', { reason: 'notify-only-spawn-threw' });
    console.info('ASSERT warn reason: notify-only-spawn-threw');
  });

  it('async spawn error warns notify-only-spawn-error', () => {
    notify();
    child.emit('error', new Error('ENOENT'));
    expect(h.warn).toHaveBeenCalledWith('Native needs-input notification failed', { reason: 'notify-only-spawn-error' });
  });

  it('failed helper exit is traceable without logging user text or executable path', () => {
    notify();
    child.emit('exit', 4, null);
    expect(h.warn).toHaveBeenCalledWith('Native needs-input notification failed', { reason: 'notify-only-exit-failed', code: 4, signal: null });
  });

  it('non-darwin warns notify-only-platform-unsupported', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(Notification, 'isSupported').mockReturnValue(true);
    notify();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith('Native needs-input notification unavailable', { reason: 'notify-only-platform-unsupported' });
  });
});
