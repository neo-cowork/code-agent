import { describe, expect, it } from 'vitest';
import { countToolSteps, resolveBackgroundTerminalKey, resolveRunTerminalKey } from '../../../src/renderer/utils/terminalWord';
import { BACKGROUND_TASK_CANCELLED } from '../../../src/shared/constants';

describe('terminalWord 解析器', () => {
  it('前台 run：停止 / 闲置回收 / 阻塞 / 全败 / 部分败 / 干净完成 / 活跃', () => {
    expect(resolveRunTerminalKey({ status: 'cancelled' })).toBe('cancelled-by-user');
    expect(resolveRunTerminalKey({ status: 'cancelled', terminalReason: 'idle_reaped' })).toBe('failed-idle-reaped');
    expect(resolveRunTerminalKey({ status: 'blocked' })).toBe('failed-unknown');
    expect(resolveRunTerminalKey({ status: 'completed', toolStepOutcome: { failed: 1, total: 1 } })).toBe('failed-tool');
    expect(resolveRunTerminalKey({ status: 'completed', toolStepOutcome: { failed: 1, total: 3 } })).toBe('completed-with-warnings');
    expect(resolveRunTerminalKey({ status: 'completed', toolStepOutcome: { failed: 0, total: 3 } })).toBe('completed');
    expect(resolveRunTerminalKey({ status: 'completed' })).toBe('completed');
    expect(resolveRunTerminalKey({ status: 'running' })).toBeNull();
    expect(resolveRunTerminalKey({ status: 'waiting_approval' })).toBeNull();
  });

  it('后台行：取消 code、失败、完成、运行中；前台已停时 running 也按停止', () => {
    expect(resolveBackgroundTerminalKey({ status: 'completed', completionMessage: BACKGROUND_TASK_CANCELLED })).toBe('cancelled-by-user');
    expect(resolveBackgroundTerminalKey({ status: 'failed' })).toBe('failed-unknown');
    expect(resolveBackgroundTerminalKey({ status: 'completed' })).toBe('completed');
    expect(resolveBackgroundTerminalKey({ status: 'running' })).toBeNull();
    expect(resolveBackgroundTerminalKey({ status: 'running' }, { taskCancelled: true })).toBe('cancelled-by-user');
    expect(resolveBackgroundTerminalKey({ status: 'completed' }, { toolStepOutcome: { failed: 1, total: 1 } })).toBe('failed-tool');
    expect(resolveBackgroundTerminalKey({ status: 'completed' }, { toolStepOutcome: { failed: 1, total: 3 } })).toBe('completed-with-warnings');
    expect(resolveBackgroundTerminalKey({ status: 'completed' }, { toolStepOutcome: { failed: 0, total: 2 } })).toBe('completed');
  });

  it('countToolSteps：原始 toolResults 与已合并 toolCalls[].result 都认，按调用 id 去重', () => {
    expect(countToolSteps([
      { toolCalls: [{ id: 'a' }, { id: 'b' }] },
      { toolResults: [{ toolCallId: 'a', success: false }, { toolCallId: 'b', success: true }] },
    ])).toEqual({ failed: 1, total: 2 });
    expect(countToolSteps([
      { toolCalls: [{ id: 'a', result: { success: false } }], toolResults: [{ toolCallId: 'a', success: false }] },
    ])).toEqual({ failed: 1, total: 1 });
    expect(countToolSteps([{ toolCalls: [{ id: 'a' }] }])).toBeUndefined();
  });
});
