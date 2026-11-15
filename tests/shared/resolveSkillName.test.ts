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


it.each(['zh', 'en'] as const)('removes identifiers from names without placeholders (%s)', (language) => {
  const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  for (const suffix of [` · ${id}`, ` (ticket ${id})`, `（工单 ${id}）`]) {
    expect(humanizeInternalText(`Weekly report${suffix}`, language, { omitIds: true }).text).toBe('Weekly report');
  }
  expect(humanizeInternalText('Report (ID)', language, { omitIds: true }).text).toBe('Report (ID)');
});


it('keeps user file names that resemble catalog ids', () => {
  expect(humanizeInternalText('Read weekly-report-synthesis.md', 'en').text).toBe('Read weekly-report-synthesis.md');
});
