import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
const completion = read('src/host/agent/subagentExecutorCompletion.ts');
const registry = read('src/host/agent/backgroundSubagentRegistry.ts');

describe('markup-only sub-agent output is judged on stripped text', () => {
  it('both emptiness predicates use stripCardToolCallMarkup', () => {
    expect(completion).toContain("import { stripCardToolCallMarkup } from '../../shared/modelMarkupStrip'");
    expect(registry).toContain("import { stripCardToolCallMarkup } from '../../shared/modelMarkupStrip'");
    expect(completion).toContain('stripCardToolCallMarkup(finalOutput)');
    expect(registry).toContain('stripCardToolCallMarkup(returned.output)');
  });

  it('no raw-string emptiness readers remain', () => {
    expect(registry).not.toContain('!returned.output.trim()');
    expect(completion).not.toContain('finalOutput ? undefined');
  });
});
