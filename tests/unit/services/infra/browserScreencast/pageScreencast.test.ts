import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PAGE_SCREENCAST_OPTIONS, startPageScreencast } from '../../../../../src/host/services/infra/browser/pageScreencast';

describe('startPageScreencast startup capture', () => {
  it('retains the already captured viewport image when a static page emits no frame event', async () => {
    const send = vi.fn(async (method: string) => method === 'Page.captureScreenshot' ? { data: 'ACTUAL_WIDE_IMAGE' } : {});
    const detach = vi.fn(async () => undefined);
    const emit = vi.fn();
    const page = { context: () => ({ newCDPSession: async () => ({ on: vi.fn(), send, detach }) }),
      viewportSize: () => ({ width: 960, height: 716 }) };
    const handle = await startPageScreencast(page as never, DEFAULT_PAGE_SCREENCAST_OPTIONS, emit);
    expect(handle.initialFrame).toMatchObject({ base64: 'ACTUAL_WIDE_IMAGE', width: 960, height: 716 });
    expect(send.mock.calls.filter(([method]) => method === 'Page.captureScreenshot')).toHaveLength(1);
    expect(emit).not.toHaveBeenCalled();
    await handle.stop();
    expect(detach).toHaveBeenCalledOnce();
  });

  it('does not invent an initial image when the startup capture fails', async () => {
    const page = { context: () => ({ newCDPSession: async () => ({ on: vi.fn(),
      send: async (method: string) => { if (method === 'Page.captureScreenshot') throw new Error('capture failed'); },
      detach: async () => undefined,
    }) }), viewportSize: () => ({ width: 960, height: 716 }) };
    const handle = await startPageScreencast(page as never, DEFAULT_PAGE_SCREENCAST_OPTIONS, vi.fn());
    expect(handle.initialFrame).toBeUndefined();
    await handle.stop();
  });
});
