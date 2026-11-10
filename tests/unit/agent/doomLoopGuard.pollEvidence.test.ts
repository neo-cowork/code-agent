// ============================================================================
// N-FIX-DOOMLOOP-BG-POLL-FALSE-HANDBACK 返修 r5：轮询豁免必须有卡死窗口接手
// ============================================================================
// 轮询步不走 L1/L2 的前提是「结果链在跑」——上一步结果已回灌，且最后一条观察
// 就是这个轮询身份。下面每个形状在修复前都是「豁免了，但卡死窗口永远起不来」。

import { describe, it, expect } from 'vitest';
import { DoomLoopGuard } from '../../../src/host/agent/runtime/doomLoopGuard';
import { SubagentDoomLoopGuard, SubagentDoomLoopStopError } from '../../../src/host/agent/subagentDoomLoopGuard';

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args });
const ok = (name: string, args: Record<string, unknown>, summary: string) => ({
  name,
  arguments: args,
  success: true,
  summary,
});

const T0 = 1_762_300_000_000;
const RUNNING = '1. 抓站 [running] id=task_bg_42';

describe('DoomLoopGuard 轮询身份：豁免与结果跟踪同一判据', () => {
  // task_output {} 与 Process poll 缺 id 的回归在 doomLoopGuard.test.ts 的 (R1)(R2)。
  it.each(['output', 'log'])('(a) Process {action:"%s"} 缺 id ×4 → 取不到轮询身份，不豁免：第 3 次 doom-loop、第 4 次 abort', (action) => {
    let nowMs = T0;
    const guard = new DoomLoopGuard(() => nowMs);
    const levels: string[] = [];
    for (let i = 0; i < 4; i++) {
      nowMs += 25_000;
      levels.push(guard.recordStep([call('Process', { action })]).level);
      guard.recordResults([ok('Process', { action }, 'No background tasks found.')]);
    }
    expect(levels).toEqual(['none', 'none', 'doom-loop', 'doom-loop-abort']);
  });
});

describe('DoomLoopGuard 轮询豁免只给「整步只有一个轮询调用」', () => {
  // [Bash X, task_status {}] 整步重复的回归在 doomLoopGuard.test.ts 的 (R3)。
  it('(b-2) [task_output bg-1, task_output bg-2] 整步重复 ×3 → 第 3 步 repeated-step（与改动前一致）', () => {
    let nowMs = T0;
    const guard = new DoomLoopGuard(() => nowMs);
    const stepCalls = [call('task_output', { task_id: 'bg-1' }), call('task_output', { task_id: 'bg-2' })];
    const levels: string[] = [];
    for (let i = 0; i < 3; i++) {
      nowMs += 25_000;
      levels.push(guard.recordStep(stepCalls).level);
      guard.recordResults([
        ok('task_output', { task_id: 'bg-1' }, '=== Task bg-1 ===\nStatus: running\n--- Output ---\ncompiling'),
        ok('task_output', { task_id: 'bg-2' }, '=== Task bg-2 ===\nStatus: running\n--- Output ---\nlinting'),
      ]);
    }
    expect(levels).toEqual(['none', 'none', 'repeated-step']);
  });

  it('(b-3) 同一步里塞两个一模一样的 task_status {} 不算轮询步：按改动前的 L1 计数（第 2 步 doom-loop、第 3 步 abort）', () => {
    let nowMs = T0;
    const guard = new DoomLoopGuard(() => nowMs);
    const stepCalls = [call('task_status', {}), call('task_status', {})];
    const levels: string[] = [];
    for (let i = 0; i < 3; i++) {
      nowMs += 25_000;
      levels.push(guard.recordStep(stepCalls).level);
      guard.recordResults([ok('task_status', {}, RUNNING), ok('task_status', {}, RUNNING)]);
    }
    expect(levels).toEqual(['none', 'doom-loop', 'doom-loop-abort']);
  });
});

describe('DoomLoopGuard 轮询豁免要有结果证据', () => {
  it('(c-1) 调用方从不回灌 recordResults：task_status {} ×4 → 第 3 次 doom-loop、第 4 次 abort（与改动前一致）', () => {
    const guard = new DoomLoopGuard(() => T0);
    const levels = [0, 1, 2, 3].map(() => guard.recordStep([call('task_status', {})]).level);
    expect(levels).toEqual(['none', 'none', 'doom-loop', 'doom-loop-abort']);
  });

  it('(c-2) 子代理守卫（只 recordStep、不回灌结果）：同一个 task_output 轮询第 4 次停掉子代理', () => {
    const guard = new SubagentDoomLoopGuard();
    const pollCall = call('task_output', { task_id: 'bg-1' });
    guard.recordStep([pollCall]);
    guard.recordStep([pollCall]);
    guard.recordStep([pollCall]);
    expect(() => guard.recordStep([pollCall])).toThrow(SubagentDoomLoopStopError);
  });

  it('(c-3) 结果回灌中途断了：豁免随之失效，原 L2/L1 立刻接手（repeated-step → doom-loop → abort）', () => {
    let nowMs = T0;
    const guard = new DoomLoopGuard(() => nowMs);
    const statusCall = call('task_status', {});
    const levels: string[] = [];
    for (let i = 0; i < 3; i++) {
      nowMs += 25_000;
      levels.push(guard.recordStep([statusCall]).level);
      guard.recordResults([ok('task_status', {}, RUNNING)]);
    }
    for (let i = 0; i < 5; i++) {
      nowMs += 25_000;
      levels.push(guard.recordStep([statusCall]).level);
      guard.recordResults([]); // 本步没有任何工具结果落账
    }
    // 第 4 次调用时第 3 步的结果还在（仍豁免）。之后没有证据：整步签名早已连续相同，
    // L2 当步就提醒；L1 从 1 数起，数满 3 次 doom-loop，再一次 abort。
    expect(levels).toEqual([
      'none', 'none', 'none', 'none',
      'repeated-step', 'repeated-step', 'doom-loop', 'doom-loop-abort',
    ]);
  });

  it('(c-4) 结果配不上调用名（回灌里 name 为空）：task_status {} ×4 仍按 L1 升级', () => {
    let nowMs = T0;
    const guard = new DoomLoopGuard(() => nowMs);
    const levels: string[] = [];
    for (let i = 0; i < 4; i++) {
      nowMs += 25_000;
      levels.push(guard.recordStep([call('task_status', {})]).level);
      guard.recordResults([{ name: '', success: true, summary: RUNNING }]);
    }
    expect(levels).toEqual(['none', 'none', 'doom-loop', 'doom-loop-abort']);
  });
});
