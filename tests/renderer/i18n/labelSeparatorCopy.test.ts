// N-FIX-EN-MEMBER-NOTE-FULLWIDTH-COLON：标签与其后内容之间的分隔符收进词条本身——
// zh 全角冒号「：」（像素不变），en 半角冒号+空格「: 」，en 词条不得出现 U+FF1A。
// 渲染层面的断言见 traceNodeRenderer.memberInputNote.test.tsx 与
// AutomationReviewInbox.test.tsx（voided 行）；这里只锁公共词条。
import { describe, expect, it } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const FULLWIDTH_COLON = '：';

const EN_SEPARATED: Array<[string, string]> = [
  ['expert.memberBar.mainRecordSupplement', en.expert.memberBar.mainRecordSupplement],
  ['expert.memberBar.mainRecordRedirect', en.expert.memberBar.mainRecordRedirect],
  ['expert.rolePackConsent.toolsOther', en.expert.rolePackConsent.toolsOther],
  ['cronCenter.parkedVoidedLabel', en.cronCenter.parkedVoidedLabel],
  ['projectSpace.cloudCardsLoadFailed', en.projectSpace.cloudCardsLoadFailed],
  ['engineCompat.catalogSection.remoteDefaultLabel', en.engineCompat.catalogSection.remoteDefaultLabel],
];

const ZH_SEPARATED: Array<[string, string]> = [
  ['expert.memberBar.mainRecordSupplement', zh.expert.memberBar.mainRecordSupplement],
  ['expert.memberBar.mainRecordRedirect', zh.expert.memberBar.mainRecordRedirect],
  ['expert.rolePackConsent.toolsOther', zh.expert.rolePackConsent.toolsOther],
  ['cronCenter.parkedVoidedLabel', zh.cronCenter.parkedVoidedLabel],
  ['projectSpace.cloudCardsLoadFailed', zh.projectSpace.cloudCardsLoadFailed],
  ['engineCompat.catalogSection.remoteDefaultLabel', zh.engineCompat.catalogSection.remoteDefaultLabel],
];

describe('labels carry their own separator (en half-width, zh full-width)', () => {
  it('en 词条自带半角冒号+空格分隔符，且不含全角冒号', () => {
    for (const [key, value] of EN_SEPARATED) {
      expect(value, `${key} (en) should end with ": "`).toMatch(/: $/);
      expect(value, `${key} (en) must not contain U+FF1A`).not.toContain(FULLWIDTH_COLON);
    }
  });

  it('zh 词条自带全角冒号分隔符，且不含半角冒号+空格（像素不变）', () => {
    for (const [key, value] of ZH_SEPARATED) {
      expect(value, `${key} (zh) should end with "："`).toMatch(/：$/);
      expect(value, `${key} (zh) must not contain half-width ": "`).not.toContain(': ');
    }
  });
});
