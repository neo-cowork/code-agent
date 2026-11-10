import { afterEach, expect, it, vi } from 'vitest';
import { AppWindow, onRendererPush } from '../../../src/host/platform/windowBridge';
import { setMainWindow } from '../../../src/host/app/window';
import { getSessionStateManager } from '../../../src/host/session/sessionStateManager';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

vi.mock('../../../src/host/context/contextHealthService', () => ({ initContextHealthService: vi.fn() }));

afterEach(() => {
  setMainWindow(null);
  getSessionStateManager().clear();
});

it('wires runtime status pushes when the web host registers its existing window', () => {
  const window = new AppWindow();
  const pushed = vi.fn();
  const unsubscribe = onRendererPush(pushed);
  try {
    setMainWindow(window);
    getSessionStateManager().updateStatus('scheduled-run', 'running');
    expect(pushed).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_STATUS_UPDATE, expect.objectContaining({
      sessionId: 'scheduled-run', status: 'running', activeAgentCount: 1,
    }));
    getSessionStateManager().updateStatus('scheduled-run', 'idle');
    expect(pushed).toHaveBeenLastCalledWith(IPC_CHANNELS.SESSION_STATUS_UPDATE, expect.objectContaining({
      sessionId: 'scheduled-run', status: 'idle',
    }));
    pushed.mockClear();
    setMainWindow(null);
    getSessionStateManager().updateStatus('scheduled-run', 'running');
    expect(pushed).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
    window.destroy();
  }
});
