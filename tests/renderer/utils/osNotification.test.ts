import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const notificationPlugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  onAction: vi.fn(),
}));

const domainInvoke = vi.hoisted(() => vi.fn());
const tauriInvoke = vi.hoisted(() => vi.fn());
const getNativeDesktopPermissionStatus = vi.hoisted(() => vi.fn());
const isNativeDesktopAvailable = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-notification', () => notificationPlugin);
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  getNativeDesktopPermissionStatus,
  isNativeDesktopAvailable,
}));

function installTauriWindow(): void {
  (globalThis as Record<string, unknown>).window = {
    __TAURI_INTERNALS__: { invoke: tauriInvoke },
    domainAPI: {
      invoke: domainInvoke,
    },
  };
}

describe('osNotification', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installTauriWindow();
    // 本文件是 node 环境（无 document）：焦点门控的安全访问视为"失焦"，
    // 既有发送路径用例不受影响；聚焦抑制由下面注入假 document 的用例覆盖。
    delete (globalThis as Record<string, unknown>).document;
    domainInvoke.mockResolvedValue({ success: true, data: null });
    tauriInvoke.mockResolvedValue({ backend: 'legacy-needed', ok: false, reason: 'test fallback' });
    isNativeDesktopAvailable.mockReturnValue(true);
    getNativeDesktopPermissionStatus.mockResolvedValue({
      permissions: [{ kind: 'notifications', status: 'granted' }],
    });
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);
    notificationPlugin.requestPermission.mockResolvedValue('granted');
  });

  it('suppresses the OS notification when the window is focused and visible', async () => {
    (globalThis as Record<string, unknown>).document = { hasFocus: () => true, hidden: false };
    const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');

    await postOsNotification({ title: '任务完成', body: '不该弹' });

    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();
    expect(domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      { mode: 'suppressed-focused', dispatched: false },
    );
  });

  describe('needs-input viewing matrix', () => {
    const cases: Array<[string, boolean, boolean, boolean, boolean]> = [
      // name, hasFocus, hidden, viewingSession, expectSent
      ['viewing + focused + visible', true, false, true, false],
      ['other session + focused + visible', true, false, false, true],
      ['viewing + unfocused', false, false, true, true],
      ['viewing + hidden', true, true, true, true],
    ];
    it.each(cases)('%s', async (_n, focus, hidden, viewingSession, expectSent) => {
      (globalThis as Record<string, unknown>).document = { hasFocus: () => focus, hidden };
      const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
      await postOsNotification({ title: '需要授权', body: 'bash' }, { urgent: true, viewingSession });
      expect(notificationPlugin.sendNotification).toHaveBeenCalledTimes(expectSent ? 1 : 0);
      expect(domainInvoke).toHaveBeenCalledWith(
        IPC_DOMAINS.NOTIFICATION,
        'reportClientDelivery',
        expectSent
          ? expect.objectContaining({ dispatched: true, urgent: true })
          : { mode: 'suppressed-viewing', dispatched: false },
      );
    });

    it('failure events ignore viewingSession', async () => {
      (globalThis as Record<string, unknown>).document = { hasFocus: () => true, hidden: false };
      const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
      await postOsNotification({ title: '失败', body: 'x' }, { urgent: true, failure: true, viewingSession: true });
      expect(notificationPlugin.sendNotification).toHaveBeenCalledTimes(1);
    });

    it('non-urgent stays suppressed-focused', async () => {
      (globalThis as Record<string, unknown>).document = { hasFocus: () => true, hidden: false };
      const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
      await postOsNotification({ title: '完成', body: 'x' }, { viewingSession: true });
      expect(domainInvoke).toHaveBeenCalledWith(
        IPC_DOMAINS.NOTIFICATION, 'reportClientDelivery', { mode: 'suppressed-focused', dispatched: false });
    });
  });

  it('sends task notifications through the Tauri notification plugin', async () => {
    const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');

    await postOsNotification({ title: '任务完成 - 循环', body: '已完成 1 轮' });

    expect(notificationPlugin.sendNotification).toHaveBeenCalledWith({
      title: '任务完成 - 循环',
      body: '已完成 1 轮',
    });
    expect(domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      { mode: 'tauri', backend: 'legacy', dispatched: true },
    );
  });

  it('uses UNC without calling the legacy plugin when the command succeeds', async () => {
    tauriInvoke.mockResolvedValue({ backend: 'unc', ok: true });
    const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');

    await postOsNotification({ title: '任务完成 - 循环', body: '已完成 1 轮' });

    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();
    expect(tauriInvoke).toHaveBeenCalledWith('post_system_notification', {
      title: '任务完成 - 循环',
      body: '已完成 1 轮',
    });
    expect(domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      { mode: 'tauri', backend: 'unc', dispatched: true },
    );
  });

  it('uses the legacy plugin only when the command says legacy-needed', async () => {
    tauriInvoke.mockResolvedValue({ backend: 'legacy-needed', ok: false, reason: 'not an app bundle' });
    const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');

    await postOsNotification({ title: '任务完成 - 循环', body: '已完成 1 轮' });

    expect(notificationPlugin.sendNotification).toHaveBeenCalledTimes(1);
    expect(domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      { mode: 'tauri', backend: 'legacy', dispatched: true },
    );
  });

  it('reports UNC failure without calling the legacy plugin', async () => {
    tauriInvoke.mockResolvedValue({ backend: 'unc', ok: false, reason: 'authorization denied' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
      await postOsNotification({ title: '任务完成 - 循环', body: '已完成 1 轮' });

      expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('[osNotification] UNUserNotificationCenter 发送失败', 'authorization denied');
      const reports = domainInvoke.mock.calls.filter((call) => call[1] === 'reportClientDelivery');
      expect(reports).toHaveLength(1);
      expect(reports[0][2]).toEqual({ mode: 'tauri', backend: 'unc', error: 'authorization denied' });
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    {
      scenario: 'bridge missing',
      arrange: () => getNativeDesktopPermissionStatus.mockRejectedValue(new Error('Tauri runtime not available')),
    },
    {
      scenario: 'bridge throws',
      arrange: () => getNativeDesktopPermissionStatus.mockRejectedValue(new Error('probe failed')),
    },
    {
      scenario: 'status unknown',
      arrange: () => getNativeDesktopPermissionStatus.mockResolvedValue({
        permissions: [{ kind: 'notifications', status: 'unknown' }],
      }),
    },
  ])('reports unknown instead of granted:true for $scenario', async ({ arrange }) => {
    arrange();
    const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');

    await postOsNotification({ title: '任务完成 - 循环', body: '已完成 1 轮' });

    expect(notificationPlugin.sendNotification).toHaveBeenCalledTimes(1);
    const reportCall = domainInvoke.mock.calls.find((call) => call[1] === 'reportClientDelivery');
    expect(reportCall?.[0]).toBe(IPC_DOMAINS.NOTIFICATION);
    expect(reportCall?.[2]).toEqual({ mode: 'tauri', backend: 'legacy', dispatched: true });
    expect(reportCall?.[2]).not.toHaveProperty('granted');
  });

  it('returns unknown outside Tauri without querying the native bridge', async () => {
    isNativeDesktopAvailable.mockReturnValue(false);
    const { getOsNotificationPermission } = await import('../../../src/renderer/utils/osNotification');

    await expect(getOsNotificationPermission()).resolves.toBe('unknown');
    expect(getNativeDesktopPermissionStatus).not.toHaveBeenCalled();
  });

  // urgent（失败类）× 焦点 2x2：只有 focused+非 urgent 被抑制
  it.each([
    { urgent: true, focused: true, sent: true },
    { urgent: true, focused: false, sent: true },
    { urgent: false, focused: true, sent: false },
    { urgent: false, focused: false, sent: true },
  ])('urgent=$urgent focused=$focused → dispatched=$sent', async ({ urgent, focused, sent }) => {
    (globalThis as Record<string, unknown>).document = { hasFocus: () => focused, hidden: false };
    const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
    // resetModules 后 osNotification 用的是新 store 实例，需同批动态取真实 store
    const { useToastStore } = await import('../../../src/renderer/hooks/useToast');

    const onOpen = vi.fn();
    await postOsNotification({ title: 't', body: 'b' }, { urgent, failure: urgent, onOpen, openLabel: '查看' });

    // 应用内 toast 只在 urgent+聚焦时出现，恰好一条且带动作按钮
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(urgent && focused ? 1 : 0);
    if (urgent && focused) {
      expect(toasts[0]).toMatchObject({ type: 'error', message: 't: b', duration: 10000, action: { label: '查看' } });
      toasts[0].action!.onClick();
      expect(onOpen).toHaveBeenCalledTimes(1);
    }

    expect(notificationPlugin.sendNotification).toHaveBeenCalledTimes(sent ? 1 : 0);
    expect(domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.NOTIFICATION,
      'reportClientDelivery',
      sent
        ? { mode: 'tauri', backend: 'legacy', dispatched: true, ...(urgent ? { urgent: true } : {}), ...(urgent && focused ? { toastShown: true } : {}) }
        : { mode: 'suppressed-focused', dispatched: false },
    );
  });

  it('needs-input（urgent 但非 failure）聚焦时不弹错误 toast，原生分发照常', async () => {
    (globalThis as Record<string, unknown>).document = { hasFocus: () => true, hidden: false };
    const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
    const { useToastStore } = await import('../../../src/renderer/hooks/useToast');

    await postOsNotification({ title: '需要你确认', body: '权限请求' }, { urgent: true, onOpen: vi.fn(), openLabel: '查看' });

    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(notificationPlugin.sendNotification).toHaveBeenCalledTimes(1);
  });

  describe('exactly one delivery report per call', () => {
    const reports = () => domainInvoke.mock.calls.filter((c) => c[1] === 'reportClientDelivery');

    it('command fallback still sends once when the legacy backend is needed', async () => {
      vi.useFakeTimers();
      try {
        const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
        const pending = postOsNotification({ title: 't', body: 'b' });
        await pending;
        expect(notificationPlugin.sendNotification).toHaveBeenCalledTimes(1);
        expect(reports()).toHaveLength(1);
        expect(reports()[0][2]).toEqual({ mode: 'tauri', backend: 'legacy', dispatched: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it('toast.error throwing on urgent failure while focused -> one report with error', async () => {
      (globalThis as Record<string, unknown>).document = { hasFocus: () => true, hidden: false };
      const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
      const { toast } = await import('../../../src/renderer/hooks/useToast');
      vi.spyOn(toast, 'error').mockImplementation(() => {
        throw new Error('toast boom');
      });
      await postOsNotification({ title: 't', body: 'b' }, { urgent: true, failure: true });
      expect(reports()).toHaveLength(1);
      expect(reports()[0][2]).toEqual({ mode: 'tauri', error: 'toast boom' });
    });

    it('legacy-needed -> one legacy report', async () => {
      getNativeDesktopPermissionStatus.mockResolvedValue({ permissions: [{ kind: 'notifications', status: 'denied' }] });
      const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
      await postOsNotification({ title: 't', body: 'b' });
      expect(reports()).toHaveLength(1);
      expect(reports()[0][2]).toMatchObject({ backend: 'legacy', dispatched: true });
    });

    it('command fallback -> one legacy report', async () => {
      getNativeDesktopPermissionStatus.mockRejectedValue(new Error('nope'));
      const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
      await postOsNotification({ title: 't', body: 'b' });
      expect(reports()).toHaveLength(1);
      expect(reports()[0][2]).toMatchObject({ backend: 'legacy', dispatched: true });
    });

    it('suppressed-focused / suppressed-viewing -> one report each', async () => {
      (globalThis as Record<string, unknown>).document = { hasFocus: () => true, hidden: false };
      const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
      await postOsNotification({ title: 't', body: 'b' });
      expect(reports()).toHaveLength(1);
      await postOsNotification({ title: 't', body: 'b' }, { urgent: true, viewingSession: true });
      expect(reports()).toHaveLength(2);
      expect(reports()[1][2]).toEqual({ mode: 'suppressed-viewing', dispatched: false });
    });

    it('tauri sendNotification error -> one report with error', async () => {
      notificationPlugin.sendNotification.mockImplementation(() => {
        throw new Error('send boom');
      });
      const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
      await postOsNotification({ title: 't', body: 'b' });
      expect(reports()).toHaveLength(1);
      expect(reports()[0][2]).toEqual({ mode: 'tauri', backend: 'legacy', error: 'send boom' });
    });

    it('web mode -> one report', async () => {
      (globalThis as Record<string, unknown>).window = { domainAPI: { invoke: domainInvoke } };
      const { postOsNotification } = await import('../../../src/renderer/utils/osNotification');
      await postOsNotification({ title: 't', body: 'b' });
      expect(reports()).toHaveLength(1);
      expect(reports()[0][2]).toMatchObject({ mode: 'web' });
    });
  });

  it('keeps UNC isolated and legacy delivery behind the legacy-needed result', () => {
    const tauriRoot = path.resolve(__dirname, '../../../src-tauri');
    const cargoToml = fs.readFileSync(path.join(tauriRoot, 'Cargo.toml'), 'utf8');
    if (!cargoToml.includes('tauri-plugin-notification')) {
      return;
    }

    const collectRsFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...collectRsFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.rs')) {
          files.push(fullPath);
        }
      }
      return files;
    };

    const rsFiles = collectRsFiles(path.join(tauriRoot, 'src'));
    const unUserNotificationCenterToken = ['UNUser', 'NotificationCenter'].join('');
    const offenders = rsFiles
      .filter((filePath) => fs.readFileSync(filePath, 'utf8').includes(unUserNotificationCenterToken))
      .filter((filePath) => path.relative(tauriRoot, filePath) !== 'src/native_notification.rs')
      .map((filePath) => path.relative(tauriRoot, filePath));

    expect(
      offenders,
      'tauri-plugin-notification (via notify-rust -> mac-notification-sys) delivers macOS banners through the legacy NSUserNotificationCenter API. Calling UNUserNotificationCenter in the same process causes macOS usernoted to reject legacy connections ("Legacy client ... connecting to modern client. You can\'t mix modern clients with legacy clients.") and silently deny all system notifications.',
    ).toEqual([]);

    const notificationSource = fs.readFileSync(
      path.resolve(__dirname, '../../../src/renderer/utils/osNotification.ts'),
      'utf8',
    );
    const legacyBranch = notificationSource.match(
      /if\s*\(result\.backend\s*===\s*['"]legacy-needed['"]\)\s*\{([\s\S]*?)\n\s*\}/,
    );
    const sendCalls = [...notificationSource.matchAll(/sendNotification\s*\(/g)];
    expect(legacyBranch?.[1]).toContain('sendNotification');
    expect(sendCalls).toHaveLength(1);
  });
});
