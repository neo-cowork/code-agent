import { describe, expect, it, vi } from 'vitest';
import { BrowserService } from '../../../../src/host/services/infra/browserService';

function serviceState({ connected = true, open = true, processHandle = null }: {
  connected?: boolean;
  open?: boolean;
  processHandle?: { pid?: number; exitCode: number | null; signalCode: string | null } | null;
} = {}) {
  const service = Object.create(BrowserService.prototype) as BrowserService;
  Reflect.set(service, 'browser', { isConnected: () => connected });
  Reflect.set(service, 'context', { pages: () => [{ isClosed: () => !open }] });
  Reflect.set(service, 'browserProcess', processHandle);
  return service;
}

describe('kept window liveness across managed browser providers', () => {
  it('keeps a connected bundled Playwright window without a child process handle', () => {
    expect(serviceState().isProcessAlive()).toBe(true);
  });
  it('rejects disconnected browsers and closed pages', () => {
    expect(serviceState({ connected: false }).isProcessAlive()).toBe(false);
    expect(serviceState({ open: false }).isProcessAlive()).toBe(false);
  });
  it('rejects exited or unspawned system Chrome without probing unrelated processes', () => {
    const kill = vi.spyOn(process, 'kill');
    try {
      expect(serviceState({ processHandle: { exitCode: 1, signalCode: null, pid: 123 } }).isProcessAlive()).toBe(false);
      expect(serviceState({ processHandle: { exitCode: null, signalCode: null } }).isProcessAlive()).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });
  it('checks the recorded Chrome pid when cached references survive process death', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    try {
      expect(serviceState({ processHandle: { exitCode: null, signalCode: null, pid: 123 } }).isProcessAlive()).toBe(false);
      expect(kill).toHaveBeenCalledWith(123, 0);
    } finally { kill.mockRestore(); }
  });
});
