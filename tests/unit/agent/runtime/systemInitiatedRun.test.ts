import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../../src/shared/contract';
import { consumeSystemRunTerminalError } from '../../../../src/host/agent/runtime/systemInitiatedRun';

const terminal = { type: 'error', data: { message: 'wake turn failed' } } as AgentEvent;

describe('consumeSystemRunTerminalError', () => {
  it('hands the terminal error to the sink and withholds it from the chat stream', () => {
    const terminalErrorSink = vi.fn();
    expect(consumeSystemRunTerminalError({ terminalErrorSink }, terminal)).toBe(true);
    expect(terminalErrorSink).toHaveBeenCalledWith(terminal.data);
  });

  it('does not withhold a meta input run without a sink: nothing else would report its failure', () => {
    expect(consumeSystemRunTerminalError({ inputHistoryVisibility: 'meta' }, terminal)).toBe(false);
  });

  it('keeps ordinary user runs and non-terminal warnings flowing to the chat stream', () => {
    expect(consumeSystemRunTerminalError(undefined, terminal)).toBe(false);
    expect(consumeSystemRunTerminalError({ inputHistoryVisibility: 'visible' }, terminal)).toBe(false);
    const warning = { type: 'error', data: { message: 'slow', terminal: false } } as AgentEvent;
    expect(consumeSystemRunTerminalError({ terminalErrorSink: vi.fn() }, warning)).toBe(false);
    expect(consumeSystemRunTerminalError({ terminalErrorSink: vi.fn() }, { type: 'message', data: {} } as AgentEvent)).toBe(false);
  });
});
