import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ invoke: vi.fn(), emit: vi.fn(), emitTo: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ emit: h.emit, emitTo: h.emitTo }));
vi.mock('../../../src/renderer/utils/platform', () => ({ isTauriMode: () => true }));

beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset().mockResolvedValue(undefined);
  h.emit.mockReset().mockResolvedValue(undefined);
  h.emitTo.mockReset().mockResolvedValue(undefined);
});

describe('notification click startup listener barrier', () => {
  it('withholds the existing renderer-ready signal until the click listener registers, then emits even when invoke succeeds', async () => {
    const { deferRendererReadyUntil, signalRendererReady } = await import('../../../src/renderer/utils/rendererReady');
    let registered!: () => void;
    const listenerReady = new Promise<void>((resolve) => { registered = resolve; });
    deferRendererReadyUntil(listenerReady);
    const ready = signalRendererReady();
    await Promise.resolve();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    registered();
    await ready;
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('renderer_ready');
    expect(h.emitTo).toHaveBeenCalledExactlyOnceWith({ kind: 'App' }, 'renderer-ready');
    expect(h.invoke.mock.invocationCallOrder[0]).toBeLessThan(h.emitTo.mock.invocationCallOrder[0]);
  });

  it('releases readiness after a failed listener registration and retains the existing event fallback', async () => {
    const { deferRendererReadyUntil, signalRendererReady } = await import('../../../src/renderer/utils/rendererReady');
    h.invoke.mockRejectedValueOnce(new Error('bridge failure'));
    deferRendererReadyUntil(Promise.reject(new Error('listener failure')));
    await signalRendererReady();
    expect(h.emit).toHaveBeenCalledExactlyOnceWith('renderer-ready');
  });
});
