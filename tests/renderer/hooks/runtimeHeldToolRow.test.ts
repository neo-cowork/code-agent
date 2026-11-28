// Evidence class: hermetic-protocol. A shell step that was refused while a runtime installs (its result carries the
// runtime card) is shown by the card alone: no "command failed" row beside a card that later reads "ready".
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

const SESSION_ID = 'session-runtime-held';

function assistantWith(id: string, result: NonNullable<NonNullable<Message['toolCalls']>[number]['result']>, ts: number): Message {
  return {
    id, role: 'assistant', content: '', timestamp: ts,
    toolCalls: [{ id: result.toolCallId, name: 'Bash', arguments: { command: 'soffice --headless --convert-to pdf deck.pptx' }, result }],
  };
}

const rows = (messages: Message[]) => projectTurns(messages, SESSION_ID, false).turns.flatMap((turn) => turn.nodes)
  .filter((node) => node.type === 'tool_call').map((node) => node.toolCall!.id);

describe('a refused-then-held shell step', () => {
  const user: Message = { id: 'u1', role: 'user', content: '把 Downloads 里的 PPT 转成 PDF', timestamp: 1 };

  it('draws no failed tool row when its result carries the runtime card', () => {
    const held = assistantWith('a1', {
      toolCallId: 'call-held', success: false, error: 'Model guidance (not user copy): ready', duration: 120,
      metadata: { envAssist: { id: 'r|runtime_missing|libreoffice', sessionId: SESSION_ID, runId: 'r', class: 'runtime_missing', phase: 'fixing', target: { id: 'libreoffice', labelKey: 'env.target.libreoffice' }, updatedAt: 1, resume: { mode: 'auto' }, sentenceKey: 'env.sentence.libreofficePreparing' } },
    }, 2);
    expect(rows([user, held])).toEqual([]);
  });

  it('still draws an ordinary failed command', () => {
    const failed = assistantWith('a1', { toolCallId: 'call-failed', success: false, error: 'exit 1', duration: 5, metadata: { code: 'COMMAND_FAILED' } }, 2);
    expect(rows([user, failed])).toEqual(['call-failed']);
  });
});
