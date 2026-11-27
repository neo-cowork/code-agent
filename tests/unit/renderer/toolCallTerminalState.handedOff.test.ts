import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import { isRecoverableAfterLaterSuccess } from '../../../src/renderer/hooks/failureRecovery';
import { resolveToolCallTerminalState } from '../../../src/renderer/utils/toolCallTerminalState';

const HANDOFF_ID = 'host-handoff:turn-1';
const handedOffCall: ToolCall = {
  id: 'call-1',
  name: 'Bash',
  arguments: { command: 'rm /tmp/old-report-cache.tmp' },
  result: {
    toolCallId: 'call-1',
    success: false,
    error: 'HANDED_OFF_TO_BACKGROUND',
    duration: 0,
    metadata: { skipped: true, bounced: true, code: 'HANDED_OFF_TO_BACKGROUND', handoffTaskToolCallId: HANDOFF_ID },
  },
};

function task(over: Partial<Task>): Task {
  return {
    id: 'session-work-1', sessionId: 's1', toolCallId: HANDOFF_ID, source: 'session', title: '交接',
    status: 'completed', createdAt: 1, updatedAt: 2, events: [], outputRefs: [], ...over,
  } as Task;
}

describe('a Bash call handed to a background task takes its state from that task', () => {
  it('task failed with DELETE_INCOMPLETE → failed, never recovered', () => {
    const terminal = resolveToolCallTerminalState({
      toolCall: handedOffCall, sessionId: 's1',
      tasks: [task({ status: 'failed', failure: { message: 'DELETE_INCOMPLETE', reason: 'DELETE_INCOMPLETE' }, leftoverPaths: ['/tmp/old-report-cache.tmp'] })],
    });
    expect(terminal).toMatchObject({ state: 'failed', displayStatus: 'error', handedOff: true, handedOffOutcome: 'failed', skipped: false });
    expect(terminal.handoffTask?.failure?.reason).toBe('DELETE_INCOMPLETE');
  });

  it('task completed → completed and not counted as a command that did not run', () => {
    const terminal = resolveToolCallTerminalState({ toolCall: handedOffCall, sessionId: 's1', tasks: [task({ status: 'completed' })] });
    expect(terminal).toMatchObject({ state: 'completed', stepStatus: 'completed', handedOff: true, handedOffOutcome: 'completed', skipped: false, notRun: false });
  });

  it('task still running → running', () => {
    const terminal = resolveToolCallTerminalState({ toolCall: handedOffCall, sessionId: 's1', tasks: [task({ status: 'running' })] });
    expect(terminal).toMatchObject({ state: 'running', handedOffOutcome: 'running' });
  });

  it('no task row → neutral: no failure or success claim of its own', () => {
    const terminal = resolveToolCallTerminalState({ toolCall: handedOffCall, sessionId: 's1', tasks: [] });
    expect(terminal).toMatchObject({ handedOff: true, handedOffOutcome: 'neutral', skipped: false, notRun: false });
    expect(terminal.handoffTask).toBeUndefined();
  });

  it('a task of another session with the same handoff id is not picked up', () => {
    const terminal = resolveToolCallTerminalState({ toolCall: handedOffCall, sessionId: 's1', tasks: [task({ sessionId: 's2', status: 'failed' })] });
    expect(terminal.handedOffOutcome).toBe('neutral');
  });
});

describe('failure recovery never marks a handed-off row recovered', () => {
  const trace = (code: string) => ({ id: 'c', name: 'Bash', args: {}, success: false, metadata: { bounced: true, skipped: true, code } });
  it('handed-off row is not recoverable, other gate bounces still are', () => {
    expect(isRecoverableAfterLaterSuccess(trace('HANDED_OFF_TO_BACKGROUND'))).toBe(false);
    expect(isRecoverableAfterLaterSuccess(trace('TOOL_BATCH_SKIPPED'))).toBe(true);
  });
});
