import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinSkills';
import { resolveSkillInvocationFromSkills } from '../../../../src/host/services/skills/skillInvocationResolver';
import { buildDelegatedTaskPrompt } from '../../../../src/host/services/commandCenter/delegationGuidance';

describe('delegated task prompt vs builtin skill aliases (repro)', () => {
  it('delegated prompt re-matches task-brief-builder via the bare alias scope', () => {
    const prompt = buildDelegatedTaskPrompt('open example.com and read the heading');
    const hit = resolveSkillInvocationFromSkills(prompt, BUILTIN_SKILLS);
    expect(hit?.skill.name).toBe('task-brief-builder');
    expect(hit?.matchKind).toBe('alias');
    expect(hit?.matchedText).toBe('scope');
  });
});
