// ============================================================================
// toolStepGuardRails 单测（N-JEV-WARDEN-MOCK 审查 R2 #4：取消时跳过判官 + signal 传递）
// ============================================================================

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const settleDoomLoopHandbackMock = vi.hoisted(() => vi.fn(async () => 'stop'));
vi.mock('../../../src/host/agent/runtime/doomLoopHandback', () => ({
  settleDoomLoopHandback: settleDoomLoopHandbackMock,
}));

import { runToolStepGuardRails } from '../../../src/host/agent/runtime/toolStepGuardRails';
import { DoomLoopGuard } from '../../../src/host/agent/runtime/doomLoopGuard';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

const fakeCtx = (control: Record<string, unknown>): RuntimeContext =>
  ({
    messages: [],
    turnTrace: {},
    control: {
      isCancelled: false,
      isInterrupted: false,
      runAbortController: undefined,
      forceFinalResponse: vi.fn(),
      ...control,
    },
  }) as unknown as RuntimeContext;

const fakeWarden = () => ({
  reviewToolStep: vi.fn().mockResolvedValue({ kind: 'none' }),
  interceptFinal: vi.fn().mockReturnValue(null),
});

const baseArgs = (ctx: RuntimeContext, warden: ReturnType<typeof fakeWarden>) => ({
  ctx,
  guard: new DoomLoopGuard(),
  warden: warden as never,
  toolCalls: [{ name: 'Bash', arguments: { command: 'ls' } }],
  iterations: 1,
  inject: vi.fn(),
  runTools: () => Promise.resolve('continue'),
});

describe('runToolStepGuardRails — JevWarden 取消语义（审查 R2 #4）', () => {
  it('已取消的工具步跳过判官（零调用），run 不等 Jev 请求', async () => {
    const warden = fakeWarden();
    const rails = await runToolStepGuardRails(baseArgs(fakeCtx({ isCancelled: true }), warden));
    expect(warden.reviewToolStep).not.toHaveBeenCalled();
    expect(rails).toEqual({ outcome: 'proceed', toolAction: 'continue' });
  });

  it('已中断的工具步同样跳过判官', async () => {
    const warden = fakeWarden();
    await runToolStepGuardRails(baseArgs(fakeCtx({ isInterrupted: true }), warden));
    expect(warden.reviewToolStep).not.toHaveBeenCalled();
  });

  it('未取消时 run abort signal 传进 warden 挂点输入', async () => {
    const warden = fakeWarden();
    const controller = new AbortController();
    await runToolStepGuardRails(baseArgs(fakeCtx({ runAbortController: controller }), warden));
    expect(warden.reviewToolStep).toHaveBeenCalledTimes(1);
    expect(warden.reviewToolStep.mock.calls[0][0].signal).toBe(controller.signal);
  });
});

describe('runToolStepGuardRails — steer epoch 透传（审查 R3）', () => {
  it('warden 挂点输入带活的 steerEpoch getter，反映 ctx.control 当前值', async () => {
    const warden = fakeWarden();
    const ctx = fakeCtx({ steerEpoch: 3 });
    await runToolStepGuardRails(baseArgs(ctx, warden));
    const readEpoch = warden.reviewToolStep.mock.calls[0][0].steerEpoch;
    expect(typeof readEpoch).toBe('function');
    expect(readEpoch()).toBe(3);
    (ctx.control as unknown as { steerEpoch: number }).steerEpoch = 4; // steer 后 getter 必须读到新值
    expect(readEpoch()).toBe(4);
  });
});

describe('runToolStepGuardRails — 工具执行期间 steer 整步跳过（审查 R5 #1）', () => {
  it('工具执行中 steer（epoch 变化）→ 判官零调用零裁决', async () => {
    const warden = fakeWarden();
    const ctx = fakeCtx({ steerEpoch: 0 });
    const rails = await runToolStepGuardRails({
      ...baseArgs(ctx, warden),
      runTools: () => {
        (ctx.control as unknown as { steerEpoch: number }).steerEpoch = 1; // 工具执行期间用户 steer
        return Promise.resolve('continue');
      },
    });
    expect(warden.reviewToolStep).not.toHaveBeenCalled();
    expect(rails).toEqual({ outcome: 'proceed', toolAction: 'continue' });
  });

  it('工具执行中未 steer（epoch 稳定）→ 照常送判官', async () => {
    const warden = fakeWarden();
    const ctx = fakeCtx({ steerEpoch: 0 });
    await runToolStepGuardRails(baseArgs(ctx, warden));
    expect(warden.reviewToolStep).toHaveBeenCalledTimes(1);
  });
});

// N-FIX-DOOMLOOP-BG-POLL-FALSE-HANDBACK 返修 r5：真实消息形状（assistant.toolCalls +
// tool.toolResults）经 collectGuardStepResults 回灌，轮询豁免靠这条回灌链立证据。
describe('runToolStepGuardRails — 后台轮询（N-FIX-DOOMLOOP-BG-POLL-FALSE-HANDBACK r5）', () => {
  const RUNNING = '1. 抓站 [running] id=task_bg_42';

  const pollHarness = () => {
    let nowMs = 1_762_300_000_000;
    const ctx = fakeCtx({ steerEpoch: 0 });
    const guard = new DoomLoopGuard(() => nowMs);
    const inject = vi.fn();
    const step = async (advanceMs: number, calls: { name: string; arguments: Record<string, unknown>; output: string }[]) => {
      nowMs += advanceMs;
      const rails = await runToolStepGuardRails({
        ...baseArgs(ctx, fakeWarden()),
        guard,
        inject,
        toolCalls: calls.map(({ name, arguments: args }) => ({ name, arguments: args })),
        runTools: () => {
          const messages = ctx.messages as unknown as Record<string, unknown>[];
          const ids = calls.map((_, i) => `call_${messages.length}_${i}`);
          messages.push({ role: 'assistant', toolCalls: calls.map((c, i) => ({ id: ids[i], name: c.name, arguments: c.arguments })) });
          messages.push({ role: 'tool', toolResults: calls.map((c, i) => ({ toolCallId: ids[i], success: true, output: c.output })) });
          return Promise.resolve('continue');
        },
      });
      return rails.outcome;
    };
    const injected = () => inject.mock.calls.map(([text]) => String(text));
    return { step, injected };
  };
  const taskStatus = { name: 'task_status', arguments: {}, output: RUNNING };

  it('task_status {} ×4（25s 间隔）全部放行、不注入 doom-loop；不变满 5 分钟才 doom-loop，再一次才交还', async () => {
    settleDoomLoopHandbackMock.mockClear();
    const { step, injected } = pollHarness();
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) outcomes.push(await step(25_000, [taskStatus]));
    expect(outcomes).toEqual(['proceed', 'proceed', 'proceed', 'proceed']);
    expect(injected().filter((text) => text.includes('<doom-loop-guard>'))).toEqual([]);
    expect(injected().filter((text) => text.includes('polling_repeat'))).toHaveLength(1);
    expect(settleDoomLoopHandbackMock).not.toHaveBeenCalled();

    expect(await step(250_000, [taskStatus])).toBe('proceed'); // 本步结果把不变时长记到 325s
    expect(injected().filter((text) => text.includes('<doom-loop-guard>'))).toEqual([]);
    expect(await step(20_000, [taskStatus])).toBe('proceed');
    expect(injected().filter((text) => text.includes('<doom-loop-guard>'))).toHaveLength(1);
    expect(await step(20_000, [taskStatus])).toBe('abort');
    expect(settleDoomLoopHandbackMock).toHaveBeenCalledTimes(1);
  });

  it('[Bash X, task_status {}] 整步重复 ×3 → 第 3 步注入 repeated-step 提醒', async () => {
    const { step, injected } = pollHarness();
    const bash = { name: 'Bash', arguments: { command: 'npm test' }, output: 'Tests  3 failed | 12 passed' };
    for (let i = 0; i < 2; i++) await step(25_000, [bash, taskStatus]);
    expect(injected().filter((text) => text.includes('steps have been identical'))).toEqual([]);
    await step(25_000, [bash, taskStatus]);
    expect(injected().filter((text) => text.includes('steps have been identical'))).toHaveLength(1);
  });
});
