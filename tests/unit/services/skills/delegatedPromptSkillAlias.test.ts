import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinSkills';
import { resolveSkillInvocationFromSkills } from '../../../../src/host/services/skills/skillInvocationResolver';
import { buildDelegatedTaskPrompt } from '../../../../src/host/services/commandCenter/delegationGuidance';

describe('delegated task prompt vs builtin skill aliases', () => {
  it('delegated prompt without an original request resolves to no skill', () => {
    const prompt = buildDelegatedTaskPrompt('open example.com and read the heading');
    expect(resolveSkillInvocationFromSkills(prompt, BUILTIN_SKILLS)).toBeNull();
  });

  it('delegated prompt embedding a neutral original request resolves to no skill', () => {
    const prompt = buildDelegatedTaskPrompt(
      'open example.com and read the heading',
      'open example.com and tell me the page title',
    );
    expect(resolveSkillInvocationFromSkills(prompt, BUILTIN_SKILLS)).toBeNull();
  });
});
