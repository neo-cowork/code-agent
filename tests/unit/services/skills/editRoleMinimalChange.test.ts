import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinSkillsData';

describe('edit-role 内置 skill 的最小改动规则', () => {
  const skill = BUILTIN_SKILLS.find((s) => s.name === 'edit-role');

  it('要求只改用户点名的内容、其余原样照抄、额外想法不进草稿', () => {
    expect(skill).toBeDefined();
    const text = skill!.promptContent;
    expect(text).toContain('最小改动原则');
    expect(text).toContain('原样照抄');
    expect(text).toContain('绝不放进草稿');
  });

  it('用户已点名改动时不再主动邀请别的改动', () => {
    expect(skill!.promptContent).toContain('不要再问别的、也不要主动提议其他改动');
  });
});
