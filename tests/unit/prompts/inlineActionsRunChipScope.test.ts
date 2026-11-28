import { describe, expect, it } from 'vitest';
import { CONCISENESS_RULES } from '../../../src/host/prompts/identity';

const rulesText = `${CONCISENESS_RULES}`;
const inlineActions = rulesText.match(/<inline_actions>([\s\S]*?)<\/inline_actions>/)?.[1];

describe('inline_actions !run scope', () => {
  it('only offers read-only commands without absolute or escaped paths', () => {
    expect(inlineActions).toMatch(/`!run` is read-only: never delete, move, overwrite/);
    expect(inlineActions).toContain('absolute or escaped paths');
  });

  it('honours an in-session refusal and tells the agent to use Bash itself', () => {
    expect(inlineActions).toContain('after the user declines chips in this conversation');
    expect(inlineActions).toContain('Use Bash yourself for approval or say you cannot');
  });

  it('omits the typecheck run-chip example', () => {
    expect(rulesText).not.toContain('npm%20run%20typecheck');
  });
});
