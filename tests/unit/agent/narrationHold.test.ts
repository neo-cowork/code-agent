import { describe, expect, it } from 'vitest';
import { createNarrationHold, userFacingMessage } from '../../../src/host/agent/runtime/narrationSuppression';

const SENTENCE = "I'll pull your mail and calendar state first.";
const ZH_PROMPT = '请汇总我昨晚到现在的未读邮件';

function run(userPrompt: string, pieces: string[], hasToolCalls: boolean): string[] {
  const shown: string[] = [];
  const hold = createNarrationHold(userPrompt, (text) => shown.push(text));
  for (const piece of pieces) hold.emit(piece);
  hold.settle(hasToolCalls);
  return shown;
}

describe('createNarrationHold (streamed delta path)', () => {
  it('never emits the English sentence when the stream ends with a tool call', () => {
    expect(run(ZH_PROMPT, [SENTENCE], true)).toEqual([]);
  });

  it('drops only the English sentence and keeps order of later Chinese text', () => {
    expect(run(ZH_PROMPT, [SENTENCE, '好的。'], true)).toEqual(['好的。']);
  });

  it('releases the same sentence unchanged for a final answer (no tool calls)', () => {
    expect(run(ZH_PROMPT, [SENTENCE, '好的。'], false)).toEqual([SENTENCE, '好的。']);
  });

  it('passes the sentence straight through when the user asked for English', () => {
    expect(run('请用英文回复，并查邮件', [SENTENCE], true)).toEqual([SENTENCE]);
  });

  it('passes Chinese narration straight through', () => {
    expect(run(ZH_PROMPT, ['我先拉取邮件和日历状态。'], true)).toEqual(['我先拉取邮件和日历状态。']);
  });
});

describe('userFacingMessage', () => {
  it('returns the same message when nothing was suppressed', () => {
    const message = { id: 'm', role: 'assistant' as const, content: 'x', timestamp: 1 };
    expect(userFacingMessage(message)).toBe(message);
  });
});
