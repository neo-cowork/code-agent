// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invoke = vi.hoisted(() => vi.fn());
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
  useSessionStore: () => sessionState,
}));
vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: { getState: () => ({ regenerateLast: vi.fn() }) },
}));
vi.mock('../../../src/renderer/hooks/useKeybindingsSettings', () => ({
  useKeybindingsSettings: () => ({
    keybindings: {
      bindings: {
        'session.stop': { enabled: true, accelerator: 'Escape' },
        'settings.open': { enabled: true, accelerator: 'Cmd+,' },
      },
      globalHotkeysEnabled: false,
    },
    platform: 'darwin',
  }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => true,
    invoke,
    unsafeInvoke: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/services/nativeCommandFacade', () => ({
  invokeNativeCommandAction: vi.fn(),
  isNativeCommandRuntimeAvailable: () => false,
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
