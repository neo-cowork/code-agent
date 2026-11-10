// @vitest-environment jsdom
// AppshotsSettings 快捷键权限行（FB-457）：启动 preflight 之后，输入监控的显式请求
// 只能从这一行的按钮发生。钉住四态（未授权 / 已授权已装 / 已授权需重启 / 命令缺失）
// 和「加载 tab 不得触发 request 命令」这条红线。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppshotsSettings } from '../../../src/renderer/components/features/settings/tabs/AppshotsSettings';
import ipcService from '../../../src/renderer/services/ipcService';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const facadeInvoke = vi.hoisted(() => vi.fn());
const openSettings = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ current: 'darwin' }));

vi.mock('@shared/keybindings', () => ({
  getCurrentKeybindingPlatform: () => platform.current,
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../src/renderer/services/nativeCommandFacade', () => ({
  invokeNativeCommandAction: facadeInvoke,
  isNativeCommandRuntimeAvailable: () => true,
}));
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  openNativeDesktopSystemSettings: openSettings,
}));

interface HotkeyStatus {
  permissionGranted: boolean;
  tapInstalled: boolean;
  devChannel: boolean;
}

function mockHotkey(
  status: HotkeyStatus | Error,
  requestResult: HotkeyStatus | Error = {
    permissionGranted: true,
    tapInstalled: true,
    devChannel: status instanceof Error ? false : status.devChannel,
  },
): void {
  facadeInvoke.mockImplementation(async (action: string) => {
    if (action === 'getAppshotsHotkeyStatus') {
      if (status instanceof Error) throw status;
      return status;
    }
    if (action === 'requestAppshotsHotkeyAccess') {
      if (requestResult instanceof Error) throw requestResult;
      return requestResult;
    }
    return undefined;
  });
}

function renderTab() {
  vi.mocked(ipcService.invokeDomain).mockResolvedValue({
    appshots: { enabled: true, targetSession: 'current' },
  } as never);
  return render(<AppshotsSettings />);
}

const REQUEST_COMMAND = 'requestAppshotsHotkeyAccess';

describe('AppshotsSettings 快捷键（⌘+⌘）输入监控权限行', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.current = 'darwin';
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ language: 'zh' });
  });

  describe.each([
    ['zh', zh, '应用截图需要「屏幕录制」截窗、「辅助功能」读取窗口文本。在系统设置里允许「屏幕录制」后，请重启应用一次。若快捷键无反应，请点击下方快捷键行中的「开启快捷键」。'],
    ['en', en, 'App screenshots need Screen Recording to capture windows and Accessibility to read window text. After you allow Screen Recording in System Settings, restart the app once. If the shortcut does not respond, click "Enable shortcut" in the shortcut row below.'],
  ] as const)('权限说明（%s）', (language, locale, oldFullDescription) => {
    const text = locale.settings.appshots;

    function description() {
      return screen.getByText((_, element) => element?.tagName === 'P'
        && element.textContent?.startsWith(text.permissionsDescription) === true);
    }

    function expectBaseOnly() {
      expect(description().textContent).toBe(text.permissionsDescription);
      expect(description().textContent).toMatch(language === 'zh'
        ? /屏幕录制.{0,30}重启应用一次/
        : /Screen Recording in System Settings, restart the app once/);
      expect(description().textContent).not.toContain(text.permissionsHotkeyHint.trim());
      expect(description().textContent).not.toContain(text.hotkeyEnable);
      expect(screen.queryByRole('button', { name: text.hotkeyEnable })).toBeNull();
    }

    beforeEach(() => {
      useAppStore.setState({ language });
    });

    it('row hidden (non-macOS): 保留屏幕录制重启说明，不指向缺失的快捷键按钮', async () => {
      platform.current = 'win32';
      mockHotkey({ permissionGranted: false, tapInstalled: false, devChannel: false });
      renderTab();

      await waitFor(() => expect(facadeInvoke).toHaveBeenCalledWith('setAppshotsEnabled', { enabled: true }));
      expect(screen.queryByTestId('appshots-hotkey-permission-row')).toBeNull();
      expectBaseOnly();
    });

    it('button visible (not granted): 与修改前完整文案逐字一致', async () => {
      mockHotkey({ permissionGranted: false, tapInstalled: false, devChannel: true });
      renderTab();

      await screen.findByRole('button', { name: text.hotkeyEnable });
      expect(description().textContent).toBe(oldFullDescription);
      expect(description().textContent).not.toMatch(language === 'zh'
        ? /若快捷键无反应，请.*重启应用/
        : /If the shortcut does not respond,.*restart the app/i);
    });

    it('granted-but-not-installed: 按钮与快捷键提示同时保留', async () => {
      mockHotkey({ permissionGranted: true, tapInstalled: false, devChannel: true });
      renderTab();

      await screen.findByRole('button', { name: text.hotkeyEnable });
      expect(description().textContent).toBe(oldFullDescription);
    });

    it('tap installed: 行仍显示，隐藏按钮与快捷键提示', async () => {
      mockHotkey({ permissionGranted: true, tapInstalled: true, devChannel: false });
      renderTab();

      const row = await screen.findByTestId('appshots-hotkey-permission-row');
      expect(row.textContent).toContain(text.hotkeyStatusOn);
      expectBaseOnly();
    });

    it('status error (old shell): 隐藏行与快捷键提示', async () => {
      mockHotkey(new Error('command appshots_hotkey_status not found'));
      renderTab();

      await waitFor(() => expect(facadeInvoke).toHaveBeenCalledWith('setAppshotsEnabled', { enabled: true }));
      expect(facadeInvoke).toHaveBeenCalledWith('getAppshotsHotkeyStatus');
      expect(screen.queryByTestId('appshots-hotkey-permission-row')).toBeNull();
      expectBaseOnly();
    });

    it('post-click: 请求返回已安装后，快捷键提示与按钮一起消失', async () => {
      mockHotkey({ permissionGranted: false, tapInstalled: false, devChannel: false });
      renderTab();

      const button = await screen.findByRole('button', { name: text.hotkeyEnable });
      expect(description().textContent).toBe(oldFullDescription);
      fireEvent.click(button);

      await waitFor(() => expect(screen.queryByRole('button', { name: text.hotkeyEnable })).toBeNull());
      expect(facadeInvoke).toHaveBeenCalledWith(REQUEST_COMMAND);
      expect(screen.getByTestId('appshots-hotkey-permission-row').textContent).toContain(text.hotkeyStatusOn);
      expectBaseOnly();
    });
  });

  it('非 macOS：隐藏快捷键权限行且不查询或请求输入监控权限', async () => {
    platform.current = 'win32';
    mockHotkey({ permissionGranted: false, tapInstalled: false, devChannel: false });
    renderTab();

    await waitFor(() => {
      expect(facadeInvoke).toHaveBeenCalledWith('setAppshotsEnabled', { enabled: true });
    });
    expect(screen.queryByTestId('appshots-hotkey-permission-row')).toBeNull();
    expect(screen.queryByRole('button', { name: '开启快捷键' })).toBeNull();
    expect(screen.queryByRole('button', { name: '打开「输入监控」权限设置' })).toBeNull();
    expect(facadeInvoke.mock.calls.some((call) => call[0] === 'getAppshotsHotkeyStatus')).toBe(false);
    expect(facadeInvoke.mock.calls.some((call) => call[0] === REQUEST_COMMAND)).toBe(false);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('not granted: 显示「未开启」+「开启快捷键」+「打开系统设置」两个入口', async () => {
    mockHotkey({ permissionGranted: false, tapInstalled: false, devChannel: true });
    renderTab();

    const row = await screen.findByTestId('appshots-hotkey-permission-row');
    expect(row.textContent).toContain('未开启');
    expect(screen.getByRole('button', { name: '开启快捷键' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开「输入监控」权限设置' })).toBeTruthy();
  });

  it('点击「开启快捷键」调用显式请求命令并刷新为已开启', async () => {
    mockHotkey({ permissionGranted: false, tapInstalled: false, devChannel: false });
    renderTab();
    await screen.findByTestId('appshots-hotkey-permission-row');

    fireEvent.click(screen.getByRole('button', { name: '开启快捷键' }));

    await waitFor(() => {
      expect(facadeInvoke).toHaveBeenCalledWith(REQUEST_COMMAND);
    });
    await waitFor(() => {
      expect(screen.getByTestId('appshots-hotkey-permission-row').textContent).toContain('已开启');
    });
    expect(screen.queryByTestId('appshots-hotkey-permission-hint')).toBeNull();
  });

  it('显式请求返回未授权时显示下一步提示，后续授权后隐藏', async () => {
    const denied = { permissionGranted: false, tapInstalled: false, devChannel: false };
    mockHotkey(denied, denied);
    renderTab();
    await screen.findByTestId('appshots-hotkey-permission-row');

    fireEvent.click(screen.getByRole('button', { name: '开启快捷键' }));

    const hint = await screen.findByTestId('appshots-hotkey-permission-hint');
    expect(hint.textContent).toContain('如果没有出现系统提示');
    expect(hint.textContent).toContain('用“+”按钮添加 Agent Neo 并将开关打开');

    mockHotkey(denied, { permissionGranted: true, tapInstalled: true, devChannel: false });
    fireEvent.click(screen.getByRole('button', { name: '开启快捷键' }));

    await waitFor(() => {
      expect(screen.queryByTestId('appshots-hotkey-permission-hint')).toBeNull();
    });
  });

  it('显式请求抛错时仍显示下一步提示', async () => {
    const denied = { permissionGranted: false, tapInstalled: false, devChannel: false };
    mockHotkey(denied, new Error('native request failed'));
    renderTab();
    await screen.findByTestId('appshots-hotkey-permission-row');

    fireEvent.click(screen.getByRole('button', { name: '开启快捷键' }));

    expect(await screen.findByTestId('appshots-hotkey-permission-hint')).toBeTruthy();
  });

  it('granted + installed: 显示「已开启」，不再出现开启按钮', async () => {
    mockHotkey({ permissionGranted: true, tapInstalled: true, devChannel: false });
    renderTab();

    const row = await screen.findByTestId('appshots-hotkey-permission-row');
    expect(row.textContent).toContain('已开启');
    expect(screen.queryByRole('button', { name: '开启快捷键' })).toBeNull();
  });

  it('granted but not installed (dev): 显示「开启快捷键」按钮，不出现「重启」字样', async () => {
    mockHotkey({ permissionGranted: true, tapInstalled: false, devChannel: true });
    renderTab();

    const row = await screen.findByTestId('appshots-hotkey-permission-row');
    expect(row.textContent).not.toContain('重启');
    expect(row.textContent).toContain('已授权，点右侧按钮启用');
    expect(screen.getByRole('button', { name: '开启快捷键' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开「输入监控」权限设置' })).toBeNull();
    expect(screen.queryByTestId('appshots-hotkey-permission-hint')).toBeNull();
  });

  it('granted but not installed: 点击按钮调用请求命令，返回已装上后显示「已开启」', async () => {
    mockHotkey({ permissionGranted: true, tapInstalled: false, devChannel: true });
    renderTab();
    await screen.findByTestId('appshots-hotkey-permission-row');

    fireEvent.click(screen.getByRole('button', { name: '开启快捷键' }));

    await waitFor(() => {
      expect(facadeInvoke).toHaveBeenCalledWith(REQUEST_COMMAND);
    });
    await waitFor(() => {
      expect(screen.getByTestId('appshots-hotkey-permission-row').textContent).toContain('已开启');
    });
    expect(screen.queryByRole('button', { name: '开启快捷键' })).toBeNull();
  });

  it('granted but not installed: 请求返回未授权（preflight 被推翻）→「未开启」+ 两个按钮 + 提示', async () => {
    mockHotkey(
      { permissionGranted: true, tapInstalled: false, devChannel: true },
      { permissionGranted: false, tapInstalled: false, devChannel: true },
    );
    renderTab();
    await screen.findByTestId('appshots-hotkey-permission-row');

    fireEvent.click(screen.getByRole('button', { name: '开启快捷键' }));

    await screen.findByTestId('appshots-hotkey-permission-hint');
    expect(screen.getByTestId('appshots-hotkey-permission-row').textContent).toContain('未开启');
    expect(screen.getByRole('button', { name: '开启快捷键' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开「输入监控」权限设置' })).toBeTruthy();
  });

  it('status 命令缺失（老 shell）：整行隐藏且不发请求', async () => {
    mockHotkey(new Error('command appshots_hotkey_status not found'));
    renderTab();

    await waitFor(() => {
      expect(facadeInvoke.mock.calls.some((call) => call[0] === 'getAppshotsHotkeyStatus')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('appshots-hotkey-permission-row')).toBeNull();
    });
    expect(facadeInvoke.mock.calls.some((call) => call[0] === REQUEST_COMMAND)).toBe(false);
  });

  it('加载 tab 只查状态，绝不触发 request 命令（FB-457 红线）', async () => {
    mockHotkey({ permissionGranted: false, tapInstalled: false, devChannel: true });
    renderTab();

    await screen.findByTestId('appshots-hotkey-permission-row');
    // 等 settings 加载副作用（syncNativeEnabled）也走完，避免误判「还没来得及调」
    await waitFor(() => {
      expect(ipcService.invokeDomain).toHaveBeenCalled();
    });
    expect(facadeInvoke.mock.calls.some((call) => call[0] === REQUEST_COMMAND)).toBe(false);
  });
});
