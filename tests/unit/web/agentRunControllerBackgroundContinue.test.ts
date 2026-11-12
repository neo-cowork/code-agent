// ============================================================================
// N-RESIDENT-BG-CONTINUE-RUN-SURVIVE —— 「后台继续」退出后在途 run 不被 SSE 断线取消
// ============================================================================
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import type { RunHandle } from '../../../src/host/runtime/runContext';

const broadcastSSE = vi.fn();
const sendSSE = vi.fn();

vi.mock('../../../src/web/helpers/sse', () => ({
  broadcastSSE: (channel: string, data: unknown) => broadcastSSE(channel, data),
  sendSSE: (res: unknown, event: string, data: unknown) => sendSSE(res, event, data),
}));

const { AgentRunController } = await import('../../../src/web/routes/agentRunController');
const { setDaemonQuitIntent, getDaemonQuitIntent } =
  await import('../../../src/host/services/daemon/quitIntent');

const DISCONNECT_LOG = '[AgentRouter] SSE client disconnected, run run-1 continues detached';

function setup() {
  const res = { writableEnded: false, destroyed: false, write: () => true, end: () => undefined } as unknown as Response;
  const cancel = vi.fn().mockResolvedValue(undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const controller = new AgentRunController({
    res,
    runId: 'run-1',
    sessionId: 'session-1',
    runHandle: { cancel } as unknown as RunHandle,
    logger,
    tryGetSessionManager: async () => null,
    mirrorToBroadcast: false,
  });
  return { res, cancel, logger, controller };
}

function disconnect(res: Response) {
  (res as unknown as { writableEnded: boolean; destroyed: boolean }).destroyed = true;
}

function loggedDisconnect(logger: ReturnType<typeof setup>['logger']) {
  return logger.info.mock.calls.filter((c) => c[0] === DISCONNECT_LOG).length;
}

describe('cancelForDisconnect × quit intent', () => {
  it('settled runs do not detach or log on normal response close', () => {
    const { controller, logger } = setup();
    controller.markSettled();
    controller.cancelForDisconnect();
    expect(controller.detached).toBe(false);
    expect(loggedDisconnect(logger)).toBe(0);
  });
  beforeEach(() => {
    broadcastSSE.mockClear();
    sendSSE.mockClear();
    // Each case starts from the same shell intent; transport detach is independent.
    setDaemonQuitIntent('background');
  });

  it('intent=background：SSE 断开不 cancel、不标 disconnected、不打取消日志，run 正常完成', () => {
    setDaemonQuitIntent('background');
    const { res, cancel, logger, controller } = setup();
    disconnect(res);
    controller.cancelForDisconnect();

    expect(cancel).not.toHaveBeenCalled();
    expect(loggedDisconnect(logger)).toBe(1);

    controller.emitAgentEvent({ type: 'agent_complete', data: undefined } as never);
    controller.flush();
    const types = broadcastSSE.mock.calls.map((c) => (c[1] as { type: string }).type);
    expect(types).toContain('agent_complete');
    expect(types).not.toContain('agent_cancelled');
  });

  it('detach 之后的事件镜像到全局广播（agent:event 信封），重连的壳能看到续跑', () => {
    setDaemonQuitIntent('background');
    const { res, controller } = setup();
    disconnect(res);
    controller.cancelForDisconnect();
    controller.emitSSE('turn_start', { turnId: 't1', sessionId: 'session-1', seq: 3 });

    expect(broadcastSSE).toHaveBeenCalledWith('agent:event', expect.objectContaining({
      type: 'turn_start',
      sessionId: 'session-1',
    }));
  });

  it('background 意图失效或改为 stop，再断线仍继续', () => {
    setDaemonQuitIntent('stop');
    const { res, cancel, controller } = setup();
    disconnect(res);
    controller.cancelForDisconnect();

    expect(cancel).not.toHaveBeenCalled();
    expect(controller.detached).toBe(true);
  });

  it('断线不改写壳意图本身：armed schedules 留守判据不丢', () => {
    const { res, controller } = setup();
    disconnect(res);
    controller.cancelForDisconnect();
    expect(getDaemonQuitIntent()).toBe('background');
  });

  it('壳重新声明 background 不影响断线续跑', () => {
    setDaemonQuitIntent('stop');
    setDaemonQuitIntent('background');
    const { res, cancel, controller } = setup();
    disconnect(res);
    controller.cancelForDisconnect();

    expect(cancel).not.toHaveBeenCalled();
  });

  it('intent=stop 也不能把断线当显式 Stop；重复 close 只记录一次', () => {
    setDaemonQuitIntent('stop');
    const { res, cancel, logger, controller } = setup();
    disconnect(res);
    controller.cancelForDisconnect();

    expect(cancel).not.toHaveBeenCalled();
    expect(controller.detached).toBe(true);
    setDaemonQuitIntent('stop');
    controller.cancelForDisconnect();
    expect(loggedDisconnect(logger)).toBe(1);
  });
});
