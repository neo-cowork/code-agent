import { EventEmitter } from 'node:events';
import { NEEDS_INPUT_NATIVE_FALLBACK } from '../../../../src/shared/constants/timeouts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spawn: vi.fn(), spawnSync: vi.fn(), exec: vi.fn(), execFile: vi.fn(),
  execSync: vi.fn(), execFileSync: vi.fn(), warn: vi.fn(), broadcast: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: h.spawn, spawnSync: h.spawnSync, exec: h.exec, execFile: h.execFile,
  execSync: h.execSync, execFileSync: h.execFileSync,
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
const notify = async () => { notificationService.notifyNeedsInput({ sessionId: '--session;$(ignored)', title: 'write_file', body: 'mcp__internal', tool: 'Write' }); await vi.advanceTimersByTimeAsync(NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '');
  vi.stubEnv('CODE_AGENT_SHELL_EXE', '/Applications/Agent Neo.app/Contents/MacOS/code-agent-tauri');
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  h.spawn.mockReturnValue(child);
  notificationService.clearRecentNotifications();
  notificationService.setNativeNotificationSender(null);
  notificationService.setNotificationSessionTitleResolver(async () => '会议纪要');
});
afterEach(() => {
  for (const launch of [h.spawn, h.spawnSync, h.exec, h.execFile, h.execSync, h.execFileSync]) {
    expect(launch.mock.calls.filter(([command]) => /\bosascript\b/.test(String(command)))).toEqual([]);
  }
  notificationService.clearRecentNotifications();
  notificationService.setNotificationSessionTitleResolver(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('production notificationService needs-input background notify-only', () => {
  it('spawns argv --notify-only with title/body/id/session; never invokes platform osascript sender', async () => {
    await notify();
    const id = h.broadcast.mock.calls[0][1].id;
    expect(h.spawn).toHaveBeenCalledExactlyOnceWith(
      process.env.CODE_AGENT_SHELL_EXE,
      ['--notify-only', '--title', '会议纪要', '--body', '等你确认：写入文件', '--id', id, '--session', '--session;$(ignored)'],
      { detached: true, stdio: 'ignore', shell: false },
    );
    expect(child.unref).toHaveBeenCalledOnce();
    console.info('ASSERT spawn argv:', JSON.stringify(h.spawn.mock.calls[0]));
    const osascriptCalls = [h.spawn, h.spawnSync, h.exec, h.execFile, h.execSync, h.execFileSync]
      .flatMap((launch) => launch.mock.calls).filter(([command]) => /\bosascript\b/.test(String(command)));
    expect(osascriptCalls).toEqual([]);
    console.info('ASSERT child_process spawn/exec osascript calls:', osascriptCalls.length);
  });

  it('missing env warns notify-only-executable-missing with no osascript', async () => {
    vi.stubEnv('CODE_AGENT_SHELL_EXE', '');
    await notify();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith('Native needs-input notification unavailable', { reason: 'notify-only-executable-missing' });
    console.info('ASSERT warn reason: notify-only-executable-missing');
  });

  it('spawn throwing warns notify-only-spawn-threw with no osascript', async () => {
    h.spawn.mockImplementationOnce(() => { throw new Error('injected launch failure'); });
    await notify();
    expect(h.warn).toHaveBeenCalledWith('Native needs-input notification failed', { reason: 'notify-only-spawn-threw' });
    console.info('ASSERT warn reason: notify-only-spawn-threw');
  });

  it('async spawn error warns notify-only-spawn-error', async () => {
    await notify();
    child.emit('error', new Error('ENOENT'));
    expect(h.warn).toHaveBeenCalledWith('Native needs-input notification failed', { reason: 'notify-only-spawn-error' });
  });

  it('failed helper exit is traceable without logging user text or executable path', async () => {
    await notify();
    child.emit('exit', 4, null);
    expect(h.warn).toHaveBeenCalledWith('Native needs-input notification failed', { reason: 'notify-only-exit-failed', code: 4, signal: null });
  });

  it('non-darwin warns notify-only-platform-unsupported', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(Notification, 'isSupported').mockReturnValue(true);
    await notify();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith('Native needs-input notification unavailable', { reason: 'notify-only-platform-unsupported' });
  });
});
