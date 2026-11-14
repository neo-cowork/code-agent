import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const quitIntent = vi.hoisted(() => ({ value: 'none' as 'none' | 'background' | 'stop' }));
vi.mock('../../../../src/host/services/daemon/quitIntent', () => ({
  getDaemonQuitIntent: () => quitIntent.value,
}));

const closeIdle = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/host/services/infra/browser/closeIdleManagedBrowsers', () => ({
  closeIdleManagedBrowsers: closeIdle,
}));

import { cancelRunsOnStopIntentShutdown } from '../../../../src/host/runtime/stopIntentShutdownCancel';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import type { RunHandle } from '../../../../src/host/runtime/runContext';

function fakeHandle(runId: string, onCancel: (reason?: string) => void): RunHandle {
  return {
    context: { runId, sessionId: `s-${runId}` },
    cancellationRequested: false,
    cancel: async (reason?: string) => { onCancel(reason); },
  } as unknown as RunHandle;
}

describe('cancelRunsOnStopIntentShutdown（停止并退出：停机先 cancel 所有 run）', () => {
  const registry = new RunRegistry();
  beforeEach(() => { quitIntent.value = 'none'; closeIdle.mockClear(); registry.clear(); });
  afterEach(() => registry.clear());

  it('intent=stop：每个 run 收到 cancel("user")，run 收口后立即返回', async () => {
    quitIntent.value = 'stop';
    const calls: string[] = [];
    const log = vi.fn();
    for (const id of ['r1', 'r2']) {
      const h = fakeHandle(id, (reason) => {
        calls.push(`${id}:${reason}`);
        setTimeout(() => registry.unregister(id, h), 50); // run 自己收口
      });
      registry.register(h);
    }
    const startedAt = Date.now();
    const summary = await cancelRunsOnStopIntentShutdown(registry, { graceMs: 3_000, pollIntervalMs: 20, log });
    expect(calls.sort()).toEqual(['r1:user', 'r2:user']);
    expect(summary).toMatchObject({ intent: 'stop', cancelled: 2, remaining: 0 });
    expect(closeIdle).toHaveBeenCalledWith('shutdown'); // 取消后第二次清理浏览器
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).toContain('[shutdown] stop-intent cancel: runId=r1');
    expect(logged).toContain('[shutdown] stop-intent cancel: runId=r2');
  });

  it('intent=stop：run 不收口时宽限到期即返回（不等 60s）', async () => {
    quitIntent.value = 'stop';
    registry.register(fakeHandle('stuck', () => undefined));
    const startedAt = Date.now();
    const summary = await cancelRunsOnStopIntentShutdown(registry, { graceMs: 200, pollIntervalMs: 20, log: vi.fn() });
    expect(summary.remaining).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it.each(['none', 'background'] as const)('intent=%s：不 cancel 任何 run', async (intent) => {
    quitIntent.value = intent;
    const onCancel = vi.fn();
    registry.register(fakeHandle('r1', onCancel));
    const summary = await cancelRunsOnStopIntentShutdown(registry, { graceMs: 100, pollIntervalMs: 20, log: vi.fn() });
    expect(onCancel).not.toHaveBeenCalled();
    expect(closeIdle).not.toHaveBeenCalled();
    expect(summary.cancelled).toBe(0);
  });
});

describe('webServer.shutdown 接线（static-contract）', () => {
  it('stop 分支只走 cancel 函数，其余意图保留 drain', () => {
    const src = readFileSync('src/web/webServer.ts', 'utf8');
    expect(src).toMatch(/if \(getDaemonQuitIntent\(\) === 'stop'\) await \(await import\('[^']*stopIntentShutdownCancel'\)\)\.cancelRunsOnStopIntentShutdown\(runRegistry\);\n\s*else await drainPendingOpsForShutdown\(/);
  });
});
