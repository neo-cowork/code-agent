import { describe, expect, it } from 'vitest';
import { PARKED_APPROVAL_CLOSURE_SENTENCES } from '../../src/shared/parkedApprovalClosure';
import { en } from '../../src/renderer/i18n/en';
import { zh } from '../../src/renderer/i18n/zh';

const sharedKeys = Object.keys(PARKED_APPROVAL_CLOSURE_SENTENCES).sort();

describe('parked approval closure translation gate', () => {
  it('keeps both language key sets in one-to-one parity with the shared closure reasons', () => {
    expect(Object.keys(zh.toolStepHumanize.parkedClosure).sort()).toEqual(sharedKeys);
    expect(Object.keys(en.toolStepHumanize.parkedClosure).sort()).toEqual(sharedKeys);
  });

  it('keeps Han characters out of English closure sentences', () => {
    for (const sentence of Object.values(en.toolStepHumanize.parkedClosure)) {
      expect(sentence).not.toMatch(/[一-鿿]/u);
    }
  });
});
