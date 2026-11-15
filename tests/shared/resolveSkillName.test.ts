import { describe, expect, it } from 'vitest';
import { resolveSkillName } from '../../src/shared/resolveSkillName';
import { humanizeInternalText } from '../../src/shared/humanizeInternalText';

describe('catalog entity presentation', () => {
  it('uses the Chinese catalog name or existing English no-name wording', () => {
    expect(resolveSkillName('weekly-report-synthesis', 'zh', '使用了一个技能')).toBe('周报萃取');
    expect(resolveSkillName('weekly-report-synthesis', 'en', 'Used a skill')).toBe('Used a skill');
    expect(resolveSkillName('computer-use', 'en', 'Used a skill')).toBe('Computer Use');
  });
  it.each(['zh', 'en'] as const)('preserves user names (%s)', (language) => {
    expect(resolveSkillName('my-custom-skill', language, 'fallback')).toBe('my-custom-skill');
    expect(resolveSkillName(undefined, language, 'fallback')).toBe('fallback');
    expect(humanizeInternalText('weekly-report-synthesis read_file', language).text).not.toContain('weekly-report-synthesis');
  });
});
