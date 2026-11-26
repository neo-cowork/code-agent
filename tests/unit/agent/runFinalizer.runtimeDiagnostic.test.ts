import { describe, expect, it, vi } from 'vitest';

const loggerInfo = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), info: loggerInfo, warn: vi.fn(), error: vi.fn() }),
  };
});

import { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';

describe('RunFinalizer runtime diagnostics', () => {
  it('logs the checklist notice instead of emitting a [runtime] reasoning event', () => {
    const onEvent = vi.fn();
    const queueDiagnostic = vi.fn();
    const ctx = {
      sessionId: 's1',
      onEvent,
      turn: { currentTurnId: 'turn-1' },
      stats: { queueDiagnostic },
    };
    new RunFinalizer(ctx as never).tryParseTodosFromResponse({
      thinking: '- [ ] 看一下文件\n- [ ] 写总结',
    });

    expect(onEvent.mock.calls.filter(([e]) => e.type === 'stream_reasoning')).toEqual([]);
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain('[runtime]');
    expect(queueDiagnostic).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('[RuntimeDiagnostic] checklist: thinking 中的 checklist'));
  });
});
