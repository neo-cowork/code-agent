import { describe, expect, it } from 'vitest';
import { languages } from '../../../src/renderer/i18n';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';

describe.each(['zh', 'en'] as const)('catalog skill tool row (%s)', (language) => {
  it.each(['running', 'completed', 'failed'] as const)('resolves the name for %s', (status) => {
    const t = languages[language];
    const text = humanizeToolStep('Skill', { command: 'weekly-report-synthesis' }, t, undefined, status);
    expect(text).not.toContain('weekly-report-synthesis');
    if (language === 'zh') expect(text).toContain('周报萃取');
    else expect(text).not.toMatch(/[\u3400-\u9fff]/);
    expect(humanizeToolStep('Skill', { command: 'my-custom-skill' }, t, undefined, status)).toContain('my-custom-skill');
  });
});
