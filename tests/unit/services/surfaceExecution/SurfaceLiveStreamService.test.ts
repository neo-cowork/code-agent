import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceLiveFrameV1 } from '../../../../src/shared/contract/surfaceExecution';
import { SurfaceLiveStreamService } from '../../../../src/host/services/surfaceExecution/SurfaceLiveStreamService';

const { startPageScreencast, warn } = vi.hoisted(() => ({ startPageScreencast: vi.fn(), warn: vi.fn() }));
vi.mock('../../../../src/host/services/infra/logger', async (original) => {
  const actual = await original<typeof import('../../../../src/host/services/infra/logger')>();
  return { ...actual, createLogger: (name: string) => name === 'SurfaceLiveStream'
    ? { info: vi.fn(), warn } : actual.createLogger(name) };
});

vi.mock('../../../../src/host/services/infra/browser/pageScreencast', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startPageScreencast,
}));

type FrameEmitter = (frame: {
  base64: string; width: number; height: number; capturedAtMs: number;
}) => void;

const stop = vi.fn(async () => undefined);
let emitFrame: FrameEmitter = () => undefined;

function buildRuntime(session: Record<string, unknown> | null) {
  return { sessions: { get: () => session } } as never;
}

function buildAdapter(input: { running?: boolean; hasPage?: boolean; page?: object } = {}) {
  const running = input.running ?? true;
  const hasPage = input.hasPage ?? true;
  const page = input.page ?? { context: () => ({ newCDPSession: async () => ({
    send: async () => ({ cssContentSize: { width: 320 }, cssLayoutViewport: { clientWidth: 320 } }),
    detach: async () => undefined,
  }) }) };
  return {
    findBindingBySurfaceSessionId: () => ({
      browserService: {
        isRunning: () => running,
        getActiveTab: () => (hasPage ? { id: 'tab-1', page } : null),
      },
    }),
  } as never;
}

const RUNNING_BROWSER_SESSION = {
  sessionId: 'surface-1',
  conversationId: 'session-a',
  surface: 'browser',
  state: 'running',
};

const REQUEST = { version: 1 as const, conversationId: 'session-a', surfaceSessionId: 'surface-1' };

describe('SurfaceLiveStreamService（B1-R·R1 帧流归属与生命周期）', () => {
  let published: SurfaceLiveFrameV1[];
  const services: SurfaceLiveStreamService[] = [];
  afterEach(async () => {
    for (const service of services.splice(0)) await service.stop(REQUEST.surfaceSessionId);
    vi.useRealTimers();
  });

  beforeEach(() => {
    published = [];
    warn.mockClear();
    stop.mockClear();
    startPageScreencast.mockReset();
    startPageScreencast.mockImplementation(async (
      _page: unknown,
      _options: unknown,
      onFrame: FrameEmitter,
    ) => {
      emitFrame = onFrame;
      return { stop };
    });
  });

  function build(overrides: {
    session?: Record<string, unknown> | null;
    adapter?: ReturnType<typeof buildAdapter>;
  } = {}) {
    const service = new SurfaceLiveStreamService(
      buildRuntime(overrides.session === undefined ? RUNNING_BROWSER_SESSION : overrides.session),
      overrides.adapter ?? buildAdapter(),
      (frame) => published.push(frame),
    );
    services.push(service);
    return service;
  }


  it.each([[420, true], [320, false], [324, false], [323.9, false], [324.1, true]])(
    'CSS content width %s maps to overflow %s', async (width, expected) => {
      const send = vi.fn().mockResolvedValue({
        cssContentSize: { width }, cssLayoutViewport: { clientWidth: 320 },
      });
      const service = build({ adapter: buildAdapter({ page: {
        context: () => ({ newCDPSession: async () => ({ send, detach: async () => undefined }) }),
      } }) });
      await service.start(REQUEST);
      emitFrame({ base64: 'AAAA', width: 320, height: 600, capturedAtMs: 42 });
      expect(published.at(-1)?.pageOverflowX).toBe(expected);
      expect(send).toHaveBeenCalledWith('Page.getLayoutMetrics');
    },
  );

  it('publishes pageOverflowX through start, samples at most once per second and updates static frames', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue({ cssContentSize: { width: 420 }, cssLayoutViewport: { clientWidth: 320 } });
    const detach = vi.fn(async () => undefined);
    const service = build({ adapter: buildAdapter({ page: {
      context: () => ({ newCDPSession: async () => ({ send, detach }) }),
    } }) });
    await service.start(REQUEST);
    const frame = { base64: 'AAAA', width: 320, height: 600, capturedAtMs: 42 };
    emitFrame(frame);
    expect(published.at(-1)).toHaveProperty('pageOverflowX', true);
    for (let i = 0; i < 10; i++) emitFrame(frame);
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValue({ cssContentSize: { width: 320 }, cssLayoutViewport: { clientWidth: 320 } });
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('Page.getLayoutMetrics');
    expect(published.at(-1)).toHaveProperty('pageOverflowX', false);
    await service.stop(REQUEST.surfaceSessionId);
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(detach).toHaveBeenCalledOnce();
  });

  it('publishes the actual startup capture when Chrome emits no screencast frame after resizing', async () => {
    startPageScreencast.mockImplementationOnce(async (_page: unknown, _options: unknown, emit: FrameEmitter) => {
      emit({ base64: 'OLD_CDP_IMAGE', width: 320, height: 683, capturedAtMs: 40 });
      return { stop, initialFrame: {
        base64: 'WIDE_CAPTURE', width: 960, height: 716, capturedAtMs: 42,
      } };
    });
    const service = build();
    await service.start({ ...REQUEST, maxWidth: 960, maxHeight: 716 });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ width: 960, height: 716,
      dataUrl: 'data:image/jpeg;base64,WIDE_CAPTURE', pageOverflowX: false });
  });

  it('retains sampled metadata across capture-size restarts without another read or an absent first frame', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue({ cssContentSize: { width: 420 }, cssLayoutViewport: { clientWidth: 320 } });
    const service = build({ adapter: buildAdapter({ page: {
      context: () => ({ newCDPSession: async () => ({ send, detach: async () => undefined }) }),
    } }) });
    startPageScreencast.mockImplementation(async (_page: unknown, _options: unknown, emit: FrameEmitter) => {
      emitFrame = emit;
      emit({ base64: 'INITIAL', width: 320, height: 600, capturedAtMs: Date.now() });
      return { stop };
    });
    await service.start(REQUEST);
    expect(published).toHaveLength(1);
    expect(published[0]).toHaveProperty('pageOverflowX', true);
    await vi.advanceTimersByTimeAsync(300);
    await service.start({ ...REQUEST, maxHeight: 563 });
    expect(published).toHaveLength(2);
    expect(published[1]).toHaveProperty('pageOverflowX', true);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(699);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('omits pageOverflowX and warns with the reason after metrics fail, then recovers', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue({ cssContentSize: { width: 420 }, cssLayoutViewport: { clientWidth: 320 } });
    const service = build({ adapter: buildAdapter({ page: {
      context: () => ({ newCDPSession: async () => ({ send, detach: async () => undefined }) }),
    } }) });
    await service.start(REQUEST);
    emitFrame({ base64: 'AAAA', width: 320, height: 600, capturedAtMs: 42 });
    expect(published.at(-1)).toHaveProperty('pageOverflowX', true);
    send.mockRejectedValueOnce(new Error('CDP metric read failed'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(published.at(-1)).not.toHaveProperty('pageOverflowX');
    expect(warn).toHaveBeenCalledWith('Surface live stream layout metrics failed', {
      surfaceSessionId: 'surface-1', message: 'CDP metric read failed',
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(published.at(-1)).toHaveProperty('pageOverflowX', true);
  });

  it('does not publish metrics or images from a replaced active page', async () => {
    vi.useFakeTimers();
    let page: object = { context: () => ({ newCDPSession: async () => ({
      send: async () => ({ cssContentSize: { width: 420 }, cssLayoutViewport: { clientWidth: 320 } }),
      detach: async () => undefined,
    }) }) };
    const service = build({ adapter: { findBindingBySurfaceSessionId: () => ({
      browserService: { isRunning: () => true, getActiveTab: () => ({ page }) },
    }) } as never });
    await service.start(REQUEST);
    page = {};
    emitFrame({ base64: 'OLD', width: 320, height: 600, capturedAtMs: 42 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(published).toHaveLength(0);
  });

  it('归属对得上就开流，帧带会话归属推给 renderer', async () => {
    const service = build();

    expect(await service.start(REQUEST)).toMatchObject({ streaming: true });
    emitFrame({ base64: 'AAAA', width: 960, height: 600, capturedAtMs: 42 });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      conversationId: 'session-a',
      surfaceSessionId: 'surface-1',
      mimeType: 'image/jpeg',
      dataUrl: 'data:image/jpeg;base64,AAAA',
      width: 960,
    });
  });

  it('会话属于别的对话时拒绝开流——帧里可能有登录态页面，串会话等于泄漏', async () => {
    const service = build({
      session: { ...RUNNING_BROWSER_SESSION, conversationId: 'session-b' },
    });

    expect(await service.start(REQUEST)).toMatchObject({ streaming: false, reason: 'unsupported' });
    expect(startPageScreencast).not.toHaveBeenCalled();
  });

  it('会话不存在 / 不是 browser surface 时拒绝开流', async () => {
    expect(await build({ session: null }).start(REQUEST))
      .toMatchObject({ streaming: false, reason: 'unsupported' });
    expect(await build({ session: { ...RUNNING_BROWSER_SESSION, surface: 'computer' } }).start(REQUEST))
      .toMatchObject({ streaming: false, reason: 'unsupported' });
    expect(startPageScreencast).not.toHaveBeenCalled();
  });

  it('浏览器没在跑 / 没有活动页时给出原因，不抛错', async () => {
    expect(await build({ adapter: buildAdapter({ running: false }) }).start(REQUEST))
      .toMatchObject({ streaming: false, reason: 'not_running' });
    expect(await build({ adapter: buildAdapter({ hasPage: false }) }).start(REQUEST))
      .toMatchObject({ streaming: false, reason: 'no_active_page' });
  });

  it('stop 之后停底层 screencast，并且迟到的帧不再外推', async () => {
    const service = build();
    await service.start(REQUEST);
    emitFrame({ base64: 'AAAA', width: 960, height: 600, capturedAtMs: 1 });

    expect(await service.stop('surface-1')).toMatchObject({ streaming: false });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(service.isStreaming('surface-1')).toBe(false);

    emitFrame({ base64: 'BBBB', width: 960, height: 600, capturedAtMs: 2 });
    expect(published).toHaveLength(1);
  });

  it('同一 surface 会话的活动页被换掉（结果页关闭后重新打开）：start 必须重开流，不能沿用死页面上的旧流', async () => {
    let page = { id: 'page-old' };
    let running = true;
    const adapter = {
      findBindingBySurfaceSessionId: () => ({
        browserService: {
          isRunning: () => running,
          getActiveTab: () => ({ id: 'tab-1', page }),
        },
      }),
    } as never;
    const service = build({ adapter });
    await service.start(REQUEST);
    expect(startPageScreencast).toHaveBeenCalledTimes(1);

    // 窗口死了：旧流还挂在死页面上，此时 start 要报「没在跑」而不是 streaming:true
    running = false;
    expect(await service.start(REQUEST)).toMatchObject({ streaming: false, reason: 'not_running' });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(service.isStreaming('surface-1')).toBe(false);

    // 重新打开：同 surface 会话、新浏览器、新页面
    running = true;
    page = { id: 'page-new' };
    expect(await service.start(REQUEST)).toMatchObject({ streaming: true });
    expect(startPageScreencast).toHaveBeenCalledTimes(2);
    expect(startPageScreencast.mock.calls[1][0]).toBe(page);
    emitFrame({ base64: 'NEW', width: 960, height: 600, capturedAtMs: 7 });
    expect(published.at(-1)?.dataUrl).toBe('data:image/jpeg;base64,NEW');
  });

  it('活动页直接被换成新页面（浏览器没停）：同一 start 入口也重开流', async () => {
    let page = { id: 'page-old' };
    const adapter = {
      findBindingBySurfaceSessionId: () => ({
        browserService: { isRunning: () => true, getActiveTab: () => ({ id: 'tab-1', page }) },
      }),
    } as never;
    const service = build({ adapter });
    await service.start(REQUEST);
    page = { id: 'page-new' };
    expect(await service.start(REQUEST)).toMatchObject({ streaming: true });
    expect(startPageScreencast).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('重复 start 同一会话不重开流', async () => {
    const service = build();
    await service.start(REQUEST);
    await service.start(REQUEST);

    expect(startPageScreencast).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it('同时只维持一条流：换会话开流会先停掉上一条', async () => {
    const service = build();
    await service.start(REQUEST);
    await service.start({ ...REQUEST, surfaceSessionId: 'surface-1' });
    await service.stop('surface-1');

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('底层开流抛错时降级成不可用，不把异常抛给 IPC', async () => {
    startPageScreencast.mockRejectedValueOnce(new Error('CDP unavailable'));

    expect(await build().start(REQUEST))
      .toMatchObject({ streaming: false, reason: 'unsupported' });
  });
});
