import { describe, expect, it } from 'vitest';
import type { TraceNode, TraceTurn } from '../../../src/shared/contract/trace';
import { resolveBusySignal } from '../../../src/renderer/utils/turnBusySignal';

const TURN_START = 1_000;

function toolNode(id: string, result: string | undefined, metadata?: Record<string, unknown>): TraceNode {
  return {
    id, type: 'tool_call', content: '', timestamp: TURN_START + 1,
    toolCall: { id, name: 'Bash', args: {}, result, metadata },
  };
}

// 形状同 host bouncedToolCallSeal 的 handedOff 封口结果。
const handedOff = toolNode('t1', 'HANDED_OFF_TO_BACKGROUND', { skipped: true, bounced: true, code: 'HANDED_OFF_TO_BACKGROUND' });
const plainDone = toolNode('t2', 'ok', {});

function turn(nodes: TraceNode[]): TraceTurn {
  return { turnNumber: 1, turnId: 'turn-1', nodes, status: 'streaming', startTime: TURN_START };
}

const live = { createdAt: TURN_START + 5, live: true };
const done = { createdAt: TURN_START + 5, live: false };

describe('resolveBusySignal 后台交接', () => {
  it('(i) 已交接调用有结果且后台任务在跑 → tool，不落 text-caret', () => {
    expect(resolveBusySignal(turn([handedOff]), { tasks: [live] })).toBe('tool');
  });
  it('(ii) 同一轮任务终态后 → text-caret', () => {
    expect(resolveBusySignal(turn([handedOff]), { tasks: [done] })).toBe('text-caret');
  });
  it('(iii) 普通工具完成后等模型继续 → text-caret', () => {
    expect(resolveBusySignal(turn([plainDone]), { tasks: [] })).toBe('text-caret');
  });
  it('(iv) 有存活后台任务但本轮没有交接调用 → text-caret', () => {
    expect(resolveBusySignal(turn([plainDone]), { tasks: [live], awaitingLedger: true })).toBe('text-caret');
  });
  it('(v) 交接调用存在，但任务早于本轮开始 → text-caret', () => {
    expect(resolveBusySignal(turn([handedOff]), { tasks: [{ createdAt: TURN_START - 1, live: true }] })).toBe('text-caret');
    expect(resolveBusySignal(turn([handedOff]))).toBe('text-caret');
  });
  it('(vi) 任务未到账本且在宽限内 → tool；宽限过后 → text-caret；任务已终态不受宽限影响', () => {
    expect(resolveBusySignal(turn([handedOff]), { tasks: [], awaitingLedger: true })).toBe('tool');
    expect(resolveBusySignal(turn([handedOff]), { tasks: [], awaitingLedger: false })).toBe('text-caret');
    expect(resolveBusySignal(turn([handedOff]), { tasks: [done], awaitingLedger: true })).toBe('text-caret');
  });
});
