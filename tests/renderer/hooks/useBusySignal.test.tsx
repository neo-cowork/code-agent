// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { TraceNode, TraceTurn } from '../../../src/shared/contract/trace';
import type { Task, TaskStatus } from '../../../src/shared/contract/backgroundTask';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';
import { useBusySignal } from '../../../src/renderer/hooks/useBusySignal';

const TURN_START = 1_000;
const handedOff: TraceNode = {
  id: 't1', type: 'tool_call', content: '', timestamp: TURN_START + 1,
  toolCall: { id: 't1', name: 'Bash', args: {}, result: 'HANDED_OFF_TO_BACKGROUND', metadata: { skipped: true, bounced: true, code: 'HANDED_OFF_TO_BACKGROUND' } },
};
const turn: TraceTurn = { turnNumber: 1, turnId: 'turn-1', nodes: [handedOff], status: 'streaming', startTime: TURN_START };

function task(status: TaskStatus, sessionId = 's1', createdAt = TURN_START + 5): Task {
  return { id: 'bg1', sessionId, status, createdAt } as Task;
}

describe('useBusySignal（账本 → 进行中信号）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useBackgroundTaskStore.setState({ tasks: [], refreshTasks: vi.fn().mockResolvedValue(undefined) });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('只翻转任务 status：running → completed，tool → text-caret', () => {
    useBackgroundTaskStore.setState({ tasks: [task('running')] });
    const { result } = renderHook(() => useBusySignal(turn, 's1'));
    expect(result.current).toBe('tool');
    act(() => useBackgroundTaskStore.setState({ tasks: [task('completed')] }));
    expect(result.current).toBe('text-caret');
  });

  it('任务属别的会话 → text-caret（宽限期过后）', () => {
    useBackgroundTaskStore.setState({ tasks: [task('running', 'other')] });
    const { result } = renderHook(() => useBusySignal(turn, 's1'));
    act(() => { vi.advanceTimersByTime(6_000); });
    expect(result.current).toBe('text-caret');
  });

  it('已交接调用在、任务还没进账本：宽限内 tool 并主动拉账本；任务到账后随状态走；宽限过后 text-caret', () => {
    const { result } = renderHook(() => useBusySignal(turn, 's1'));
    expect(result.current).toBe('tool');
    expect(useBackgroundTaskStore.getState().refreshTasks).toHaveBeenCalled();
    act(() => useBackgroundTaskStore.setState({ tasks: [task('running')] }));
    expect(result.current).toBe('tool');
    act(() => useBackgroundTaskStore.setState({ tasks: [task('completed')] }));
    expect(result.current).toBe('text-caret');
  });

  it('任务始终没到账本：宽限期过后回到 text-caret', () => {
    const { result } = renderHook(() => useBusySignal(turn, 's1'));
    expect(result.current).toBe('tool');
    act(() => { vi.advanceTimersByTime(6_000); });
    expect(result.current).toBe('text-caret');
  });
});
