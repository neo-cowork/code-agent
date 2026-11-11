// N-FIX-DOOMLOOP-BG-POLL-FALSE-HANDBACK 返修 r5：真跑发现 DoomLoopGuard 放行后，
// messageProcessor 的 stagnation 闸在第 4 次相同 task_status 上报「工具调用陷入死循环」
// 并停掉本轮。轮询步的"结果不变"只由卡死窗口判，这道闸不再计数。

import { describe, it, expect } from 'vitest';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import { detectStepStagnation, fingerprintToolCall } from '../../../src/host/agent/runtime/stagnationDetector';

const RUNNING = '1. 周报复盘 [running] id=session-work-1794276995960-r9tmox';

/** 按 messageProcessor 的做法喂一步：每个调用配上结果算指纹，再做判定。 */
function feed(recent: string[], calls: { name: string; arguments: Record<string, unknown>; output: string }[]) {
  const toolCalls = calls.map((c, i) => ({ id: `call_${recent.length}_${i}`, name: c.name, arguments: c.arguments }) as ToolCall);
  const fingerprints = toolCalls.map((tc, i) =>
    fingerprintToolCall(tc, { toolCallId: tc.id, success: true, output: calls[i].output } as ToolResult));
  return detectStepStagnation(recent, toolCalls, fingerprints);
}

const taskStatus = { name: 'task_status', arguments: {}, output: RUNNING };
const probe = { name: 'Bash', arguments: { command: 'echo probe' }, output: 'probe' };

describe('detectStepStagnation — 后台轮询步不计 stagnation', () => {
  it('task_status {} 同结果 ×6（真跑 run-1 的形状）不提示也不停', () => {
    const recent: string[] = [];
    const seen = [1, 2, 3, 4, 5, 6].map(() => feed(recent, [taskStatus]));
    expect(seen.map((d) => d.detected)).toEqual([false, false, false, false, false, false]);
    expect(seen.map((d) => d.shouldStop)).toEqual([false, false, false, false, false, false]);
  });

  it('非轮询调用同参同结果：第 3 次提示、第 4 次停（与改动前一致）', () => {
    const recent: string[] = [];
    const seen = [1, 2, 3, 4].map(() => feed(recent, [probe]));
    expect(seen.map((d) => d.detected)).toEqual([false, false, true, true]);
    expect(seen.map((d) => d.shouldStop)).toEqual([false, false, false, true]);
  });

  it('取不到轮询身份的 Process poll（缺 session_id）照常计数', () => {
    const recent: string[] = [];
    const badPoll = { name: 'Process', arguments: { action: 'poll' }, output: 'session_id is required for poll action' };
    const seen = [1, 2, 3, 4].map(() => feed(recent, [badPoll]));
    expect(seen.map((d) => d.shouldStop)).toEqual([false, false, false, true]);
  });

  it('轮询步打断前面的连击：echo probe 与 task_status 交替 ×4 轮都不命中', () => {
    const recent: string[] = [];
    const seen = [];
    for (let round = 0; round < 4; round++) {
      seen.push(feed(recent, [probe]));
      seen.push(feed(recent, [taskStatus]));
    }
    expect(seen.some((d) => d.detected || d.shouldStop)).toBe(false);
  });

  it('多调用步里的轮询不是轮询步：[task_status, task_status] 照常计数（第 2 步提示、第 3 步停）', () => {
    const recent: string[] = [];
    const seen = [1, 2, 3].map(() => feed(recent, [taskStatus, taskStatus]));
    expect(seen.map((d) => d.detected)).toEqual([false, true, true]);
    expect(seen.map((d) => d.shouldStop)).toEqual([false, false, true]);
  });
});
