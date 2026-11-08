// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invoke = vi.hoisted(() => vi.fn());
const invokeNativeCommandAction = vi.hoisted(() => vi.fn());
const isNativeCommandRuntimeAvailable = vi.hoisted(() => vi.fn(() => false));
const keybindingsRuntime = vi.hoisted(() => ({
  keybindings: {
    bindings: {
      'session.stop': { enabled: true, accelerator: 'Escape' },
    } as Record<string, { enabled: boolean; accelerator: string | null }>,
    globalHotkeysEnabled: false,
  },
  platform: 'darwin' as const,
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
  useSessionStore: () => sessionState,
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
  listenTauriEvent: vi.fn(),
}));

import { useKeyboardShortcuts } from '../../../src/renderer/hooks/useKeyboardShortcuts';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

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
