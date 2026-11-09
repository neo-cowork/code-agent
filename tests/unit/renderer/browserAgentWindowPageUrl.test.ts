import { describe, expect, it } from 'vitest';
import { realPageValue } from '../../../src/renderer/components/workbench/browserAgentWindowPageUrl';

describe('realPageValue', () => {
  it('treats about:blank and empty values as no page so the last real page can show through', () => {
    expect(realPageValue('about:blank')).toBeNull();
    expect(realPageValue('  ')).toBeNull();
    expect(realPageValue(undefined)).toBeNull();
    expect(realPageValue('https://zh.wikipedia.org/')).toBe('https://zh.wikipedia.org/');
  });
});
