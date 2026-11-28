// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import { createDefaultKeybindingsSettings, type KeybindingPlatform } from '../../../src/shared/keybindings';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invoke = vi.hoisted(() => vi.fn());
const invokeNativeCommandAction = vi.hoisted(() => vi.fn());
const isNativeCommandRuntimeAvailable = vi.hoisted(() => vi.fn(() => false));
const keybindingsRuntime = vi.hoisted(() => ({
  keybindings: {
    bindings: {
      'session.stop': { enabled: true, accelerator: 'Escape' },
      // N-CRON-WEBHOOK-CLOUD-HOOK-FU1-FU2：settings.open 的签名态测试依赖这条默认绑定
      'settings.open': { enabled: true, accelerator: 'Cmd+,' },
    } as Record<string, { enabled: boolean; accelerator: string | null }>,
    globalHotkeysEnabled: false,
  },
  platform: 'darwin' as KeybindingPlatform,
}));
const setPendingPermissionRequest = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  pendingPermissionRequest: null as PermissionRequest | null,
  pendingPermissionSessionId: null as string | null,
  setPendingPermissionRequest,
  setShowSettings: vi.fn(),
  closeSettings: vi.fn(),
  openSettingsTab: vi.fn(),
  setSidebarCollapsed: vi.fn(),
  sidebarCollapsed: false,
  setShowDAGPanel: vi.fn(),
  showDAGPanel: false,
  setShowWorkspace: vi.fn(),
  showWorkspace: false,
  workbenchTabs: [] as string[],
  openWorkbenchTab: vi.fn(),
  closeWorkbenchTab: vi.fn(),
  setTaskPanelTab: vi.fn(),
  setShowCapturePanel: vi.fn(),
  setShowBrowserSurfacePanel: vi.fn(),
  setShowComputerUsePanel: vi.fn(),
  setShowFileExplorer: vi.fn(),
  openWorkspacePreview: vi.fn(),
  showSettings: false,
  isProcessing: false,
  language: 'en',
}));
const authState = vi.hoisted(() => ({ isAuthenticated: false, showAuthModal: false, setShowAuthModal: vi.fn() }));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: { getState: () => authState },
}));
const sessionState = vi.hoisted(() => ({
  currentSessionId: 'session-current',
  sessions: [{ id: 'session-current' }],
  isSessionRunning: vi.fn(() => false),
  moveToBackground: vi.fn(),
  createSession: vi.fn(),
  switchSession: vi.fn(),
  clearCurrentSession: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(() => appState, { getState: () => appState }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(() => sessionState, { getState: () => sessionState }),
}));
vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: { getState: () => ({ regenerateLast: vi.fn() }) },
}));
vi.mock('../../../src/renderer/hooks/useKeybindingsSettings', () => ({
  useKeybindingsSettings: () => keybindingsRuntime,
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => true,
    invoke,
    unsafeInvoke: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/services/nativeCommandFacade', () => ({
  invokeNativeCommandAction,
  isNativeCommandRuntimeAvailable,
}));
vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  // menu:open-settings 监听在 isTauriRuntime()=true 时挂载，需返回 unlisten Promise
  listenTauriEvent: vi.fn(() => Promise.resolve(() => {})),
}));

import { useKeyboardShortcuts } from '../../../src/renderer/hooks/useKeyboardShortcuts';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';
import { requestConfirm } from '../../../src/renderer/services/confirmPrompt';

vi.mock('../../../src/renderer/services/confirmPrompt', () => ({ requestConfirm: vi.fn() }));

const request: PermissionRequest = {
  id: 'permission-escape',
  sessionId: 'request-session',
  tool: 'Write',
  type: 'file_write',
  details: { path: '/tmp/report.txt' },
  timestamp: 1,
};

describe('useKeyboardShortcuts permission response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState.pendingPermissionRequest = request;
    appState.pendingPermissionSessionId = 'session-current';
    invoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    releaseApprovalResponse(request.id);
  });

  it('sends a deny response to the host when Escape closes a pending approval', async () => {
    renderHook(() => useKeyboardShortcuts());

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
        request.id,
        'deny',
        request.sessionId,
      );
    });
    expect(setPendingPermissionRequest).toHaveBeenCalledWith(null);
  });

  // N-APPROVAL-LANE-CLICK-DROP：transport 现在会把审批应答的传输故障 REJECT 出来——
  // 这条 deny 路径要靠既有 catch 留卡（恢复 pending request + 释放 claim）。
  it('restores the pending request when the deny send is rejected by the transport', async () => {
    invoke.mockRejectedValueOnce(new Error('审批应答发送失败 (500): boom'));
    renderHook(() => useKeyboardShortcuts());

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    await waitFor(() => {
      expect(setPendingPermissionRequest).toHaveBeenCalledWith(request, 'session-current');
    });
  });

});

describe('useKeyboardShortcuts settings close routing (N-CRON-WEBHOOK-CLOUD-HOOK-FU1-FU2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState.pendingPermissionRequest = null;
    appState.pendingPermissionSessionId = null;
    appState.showSettings = true;
  });

  afterEach(() => {
    cleanup();
    appState.showSettings = false;
  });

  it('Esc closes settings via closeSettings (return landing), not plain setShowSettings', async () => {
    renderHook(() => useKeyboardShortcuts());

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    // closeSettings 带「去设置」返回落点时回自动化页；裸 setShowSettings(false) 会把用户甩回聊天
    expect(appState.closeSettings).toHaveBeenCalledTimes(1);
    expect(appState.setShowSettings).not.toHaveBeenCalledWith(false);
  });

  it('settings open = false 时 Esc 不再走设置分支', async () => {
    appState.showSettings = false;
    renderHook(() => useKeyboardShortcuts());

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(appState.closeSettings).not.toHaveBeenCalled();
  });
});

describe('useKeyboardShortcuts global hotkey registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isNativeCommandRuntimeAvailable.mockReturnValue(true);
    invokeNativeCommandAction.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    isNativeCommandRuntimeAvailable.mockReturnValue(false);
    keybindingsRuntime.keybindings = {
      bindings: {
        'session.stop': { enabled: true, accelerator: 'Escape' },
        'settings.open': { enabled: true, accelerator: 'Cmd+,' },
      },
      globalHotkeysEnabled: false,
    };
  });

  it('excludes modifier-only bindings (Cmd+Cmd and ⌘⌘) from keybindings_set_global_hotkeys while keeping normal bindings', async () => {
    keybindingsRuntime.keybindings = {
      bindings: {
        'appshot.capture': { enabled: true, accelerator: 'Cmd+Cmd' },
        'app.toggle': { enabled: true, accelerator: '⌘⌘' },
        'app.quickAsk': { enabled: true, accelerator: 'Cmd+Shift+A' },
      },
      globalHotkeysEnabled: true,
    };

    renderHook(() => useKeyboardShortcuts());

    await waitFor(() => {
      expect(invokeNativeCommandAction).toHaveBeenCalledWith('setGlobalHotkeys', {
        bindings: [
          { actionId: 'app.quickAsk', accelerator: 'Cmd+Shift+A' },
        ],
      });
    });
  });
});

describe('signed-out settings entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState.pendingPermissionRequest = null;
    appState.showSettings = false;
    appState.setShowSettings.mockImplementation((show: boolean) => { appState.showSettings = show; });
    authState.isAuthenticated = false;
    authState.showAuthModal = true;
    authState.setShowAuthModal.mockImplementation((show: boolean) => { authState.showAuthModal = show; });
  });
  afterEach(() => {
    cleanup();
    appState.setShowSettings.mockReset();
    appState.showSettings = false;
    authState.showAuthModal = false;
  });

  it('Cmd+, opens Settings and dismisses the covering auth dialog while signed out', async () => {
    renderHook(() => useKeyboardShortcuts());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));
    });
    expect(authState.isAuthenticated).toBe(false);
    expect(appState.showSettings).toBe(true);
    expect(authState.showAuthModal).toBe(false);
    expect(authState.setShowAuthModal.mock.invocationCallOrder[0]).toBeLessThan(appState.setShowSettings.mock.invocationCallOrder[0]);
  });

  it('respects enableSettings=false without dismissing the auth dialog', async () => {
    renderHook(() => useKeyboardShortcuts({ enableSettings: false }));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));
    });
    expect(appState.showSettings).toBe(false);
    expect(authState.showAuthModal).toBe(true);
  });
});

describe('useKeyboardShortcuts session search', () => {
  afterEach(() => {
    cleanup();
    keybindingsRuntime.platform = 'darwin';
    keybindingsRuntime.keybindings = {
      bindings: {
        'session.stop': { enabled: true, accelerator: 'Escape' },
        'settings.open': { enabled: true, accelerator: 'Cmd+,' },
      },
      globalHotkeysEnabled: false,
    };
  });

  it.each(['darwin', 'win32', 'linux'] as const)('dispatches session search and prevents print on %s, leaving find untouched', async (platform) => {
    keybindingsRuntime.platform = platform;
    keybindingsRuntime.keybindings = { ...createDefaultKeybindingsSettings(platform), globalHotkeysEnabled: false };
    const openSearch = vi.fn();
    window.addEventListener('app:openSessionSearch', openSearch);
    try {
      renderHook(() => useKeyboardShortcuts());
      const modifiers = platform === 'darwin' ? { metaKey: true } : { ctrlKey: true };
      const find = new KeyboardEvent('keydown', { key: 'f', ...modifiers, bubbles: true, cancelable: true });
      document.dispatchEvent(find);
      expect(openSearch).not.toHaveBeenCalled();
      expect(find.defaultPrevented).toBe(false);
      const search = new KeyboardEvent('keydown', { key: 'p', ...modifiers, bubbles: true, cancelable: true });
      // 同步派发、立即断言：preventDefault 必须在 dispatchEvent 返回前就生效，
      // 否则真实 WebView2 上的系统打印框会漏出来（异步断言会掩盖这个时序）。
      document.dispatchEvent(search);
      expect(search.defaultPrevented).toBe(true);
      await act(async () => {});
      expect(openSearch).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('app:openSessionSearch', openSearch);
    }
  });

  it('honors a rebound session search shortcut', async () => {
    keybindingsRuntime.keybindings = {
      ...createDefaultKeybindingsSettings('darwin'), globalHotkeysEnabled: false,
      bindings: { 'sessionSearch.open': { enabled: true, accelerator: 'Cmd+Shift+S' } },
    };
    const openSearch = vi.fn();
    window.addEventListener('app:openSessionSearch', openSearch);
    try {
      renderHook(() => useKeyboardShortcuts());
      // 重绑定后 Cmd+P 不再归搜索，默认行为（打印）不得再被拦。
      const oldBinding = new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(oldBinding);
      expect(oldBinding.defaultPrevented).toBe(false);
      expect(openSearch).not.toHaveBeenCalled();
      const rebound = new KeyboardEvent('keydown', { key: 's', metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(rebound);
      expect(rebound.defaultPrevented).toBe(true);
      await act(async () => {});
      expect(openSearch).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('app:openSessionSearch', openSearch);
    }
  });
});


describe('clear conversation shortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    keybindingsRuntime.keybindings.bindings['session.clear'] = { enabled: true, accelerator: 'Cmd+Shift+K' };
  });

  afterEach(() => {
    cleanup();
    delete keybindingsRuntime.keybindings.bindings['session.clear'];
    sessionState.currentSessionId = 'session-current';
  });

  it.each([
    { confirmed: false, sessionId: 'session-current', clears: false },
    { confirmed: true, sessionId: 'session-current', clears: true },
    { confirmed: true, sessionId: 'another-session', clears: false },
  ])('resolves confirmed=$confirmed in $sessionId after consuming the keydown', async ({ confirmed, sessionId, clears }) => {
    let resolve!: (value: boolean) => void;
    vi.mocked(requestConfirm).mockReturnValueOnce(new Promise<boolean>((settle) => { resolve = settle; }));
    renderHook(() => useKeyboardShortcuts());
    const event = new KeyboardEvent('keydown', {
      key: 'K', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
    });
    act(() => { document.dispatchEvent(event); });

    expect(event.defaultPrevented).toBe(true);
    expect(requestConfirm).toHaveBeenCalledExactlyOnceWith({
      title: 'Clear conversation messages',
      message: 'Clear all messages in the current conversation?',
      confirmText: 'Clear',
      variant: 'danger',
    });
    expect(sessionState.clearCurrentSession).not.toHaveBeenCalled();

    sessionState.currentSessionId = sessionId;
    await act(async () => { resolve(confirmed); });
    expect(sessionState.clearCurrentSession).toHaveBeenCalledTimes(clears ? 1 : 0);
  });
});
