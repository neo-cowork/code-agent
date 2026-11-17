// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useWorkbenchBrowserSession } from '../../../src/renderer/hooks/useWorkbenchBrowserSession';

const invokeDomain = vi.hoisted(() => vi.fn(async () => ({ running: false, tabCount: 0, activeTab: null })));

vi.mock('../../../src/renderer/services/surfaceIntentDispatcher', () => ({ openSurfaceForArtifact: vi.fn() }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain, on: () => () => undefined },
}));
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  isNativeDesktopAvailable: () => false,
  getNativeDesktopCapabilities: async () => null,
  getNativeDesktopCollectorStatus: async () => null,
  getNativeDesktopPermissionStatus: async () => null,
  getFrontmostDesktopContext: async () => null,
  getComputerSurfaceState: async () => null,
  listRecentNativeDesktopEvents: async () => [],
  openNativeDesktopSystemSettings: async () => undefined,
  startNativeDesktopCollector: async () => undefined,
}));

afterEach(() => { cleanup(); invokeDomain.mockClear(); });

describe('useWorkbenchBrowserSession repair launch', () => {
  it('ensureManagedBrowserSession payload carries the current conversationId', async () => {
    useSessionStore.setState({ currentSessionId: 'conv-hook' });
    const { result } = renderHook(() => useWorkbenchBrowserSession());
    await waitFor(() => expect(result.current).toBeTruthy());
    await act(async () => {
      await result.current.runRepairAction({ kind: 'launch_managed_browser' } as never);
      await result.current.runRepairAction({ kind: 'launch_managed_browser_visible' } as never);
    });
    const calls = (invokeDomain.mock.calls as unknown as unknown[][]).filter((c) => c[1] === 'ensureManagedBrowserSession');
    expect(calls.map((c) => c[2])).toEqual([
      { mode: 'headless', profileMode: 'persistent', conversationId: 'conv-hook' },
      { mode: 'visible', profileMode: 'persistent', conversationId: 'conv-hook' },
    ]);
  });
});
