import { describe, expect, it } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u9fff]/;

describe('en.questionForm font samples', () => {
  it('keeps sampleSerif and sampleSans free of CJK characters', () => {
    expect(en.questionForm.sampleSerif).not.toMatch(CJK_PATTERN);
    expect(en.questionForm.sampleSans).not.toMatch(CJK_PATTERN);
  });
});
