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

  it('releases held text in order once Chinese shows up (whole message is not suppressed, matching the persisted rule)', () => {
    expect(run(ZH_PROMPT, [SENTENCE, '好的。'], true)).toEqual([SENTENCE, '好的。']);
  });

  it('does not stall a Chinese answer that starts with an English code/command line', () => {
    const shown: string[] = [];
    const hold = createNarrationHold(ZH_PROMPT, (text) => shown.push(text));
    hold.emit('npm run build --workspace app --verbose\n');
    expect(shown).toEqual([]);
    hold.emit('这条命令会构建应用。\n');
    expect(shown).toEqual(['npm run build --workspace app --verbose\n', '这条命令会构建应用。\n']);
    hold.emit('git status --short --branch now\n');
    expect(shown).toHaveLength(3);
  });

  it('streams Chinese text with later English code lines straight through while tool calls are pending', () => {
    expect(run(ZH_PROMPT, ['先看目录：\n', 'ls -la some other folder\n'], true)).toEqual(['先看目录：\n', 'ls -la some other folder\n']);
  });

  it('releases held text when the round fails or is cancelled (settle(false) from the finally path)', () => {
    expect(run(ZH_PROMPT, [SENTENCE], false)).toEqual([SENTENCE]);
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

  it('blanks text parts of a suppressed message and keeps the tool_call part (emitted event copy)', () => {
    const copy = userFacingMessage({
      id: 'm', role: 'assistant', content: SENTENCE, timestamp: 1, metadata: { narrationSuppressed: true },
      contentParts: [{ type: 'text', text: SENTENCE }, { type: 'tool_call', toolCallId: 'c1' }],
    });
    expect(copy.contentParts).toEqual([{ type: 'text', text: '' }, { type: 'tool_call', toolCallId: 'c1' }]);
    expect(JSON.stringify({ ...copy, metadata: undefined })).not.toContain('pull your mail');
    expect(copy.metadata?.suppressedNarration).toBe(SENTENCE);
  });
});
