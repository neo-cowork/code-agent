import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { resolveRunCancellationOutcomeKey, resolveStreamInterruptionOutcomeKey } from '../../../src/renderer/i18n/outcomeWords';
import { streamInterruptionReasonFromContent } from '../../../src/renderer/utils/streamInterruptionPresentation';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { buildStreamRecoveryMessage } from '../../../src/renderer/utils/streamRecoveryMessage';
import { buildRunUiState } from '../../../src/renderer/utils/runWorkbenchProjection';
import { resolveToolTerminalOutcomeKey } from '../../../src/renderer/utils/toolExecutionPresentation';

// Match persisted ConversationRuntime markers, not an invented renderer-only reason.
describe('disconnect and explicit Stop have distinct outcomes in both languages', () => {
  it.each([zh, en])('resolves timeline, badge and event causes consistently', (t) => {
    const disconnected = resolveStreamInterruptionOutcomeKey(streamInterruptionReasonFromContent('Summary\n\n[连接中断 — 部分回答已保留]'));
    const stopped = resolveStreamInterruptionOutcomeKey(streamInterruptionReasonFromContent('Summary\n\n[cancelled]'));
    expect(disconnected).toBe('interrupted-stream-break');
    expect(stopped).toBe('cancelled-by-user');
    expect(resolveRunCancellationOutcomeKey('client_disconnect')).toBe(disconnected);
    expect(resolveRunCancellationOutcomeKey('user_cancelled')).toBe(stopped);
    expect(t.outcomeWords[disconnected].timeline.reason).toBe(t === zh ? '网络断连时中断' : 'Interrupted when the connection dropped');
    expect(t.outcomeWords[stopped].timeline.reason).toBe(t === zh ? '你停止了这次执行' : 'You stopped this run');
    expect(t.outcomeWords[disconnected].timeline.reason).not.toBe(t.outcomeWords[stopped].timeline.reason);
  });

  it.each(['Summary so far', ''])('reload preserves disconnect metadata for run cards (%j)', (text) => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Summarize the meeting notes', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: `${text}\n\n[连接中断 — 部分回答已保留]`, timestamp: 2,
        metadata: { streamInterruptionReason: 'stream-break', workbench: { runCancellation: { status: 'cancelled', cancelledAt: 2, reason: 'client_disconnect' } } } },
    ];
    messages.push(buildStreamRecoveryMessage({ sessionId: 's1', streamStatus: 'incomplete', stableForExecution: false, incompleteToolCallIds: [], turnId: 'snapshot-1', content: '', reasoning: 'Planning the summary', toolCalls: [], timestamp: 3, isFinal: false, estimatedTokens: 1 }, 'stream-break'));
    const projection = projectTurns(messages, 's1', false);
    expect(projection.turns.flatMap((turn) => turn.nodes).some((node) => node.metadata?.streamInterruptionReason === 'stream-break')).toBe(true);
    const run = buildRunUiState({ projection, sessionId: 's1', sessionStatus: 'cancelled' });
    expect(run.terminalReason).toBe('client_disconnect');
    expect(resolveRunCancellationOutcomeKey(run.terminalReason)).toBe('interrupted-stream-break');
  });

  it('tool terminal resolver retains explicit Stop and recognizes disconnect metadata', () => {
    expect(resolveToolTerminalOutcomeKey({ result: { toolCallId: 'tool-1', success: false, metadata: { cancellationReason: 'client-disconnect' } } })).toBe('interrupted-stream-break');
    expect(resolveToolTerminalOutcomeKey({ result: { toolCallId: 'tool-1', success: false, metadata: { cancellationReason: 'user-cancel' } } })).toBe('cancelled-by-user');
  });
});
