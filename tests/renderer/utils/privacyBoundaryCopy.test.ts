import { describe, expect, it } from 'vitest';
import { privacyBoundaryIndexEn } from '../../../src/renderer/i18n/privacyBoundaryIndexEn';
import { getPrivacyBoundaryEntryCopy } from '../../../src/renderer/utils/privacyBoundaryCopy';
import {
  getPrivacyBoundaryActionShortLabel,
  listPrivacyBoundaryIndexEntries,
} from '../../../src/shared/contract/privacyBoundaryIndex';

const HAN = /[㐀-䶿一-鿿豈-﫿]/u;
const entries = listPrivacyBoundaryIndexEntries();

describe('隐私边界索引跟随界面语言（FB-1289）', () => {
  it('中文界面：每个条目显示的就是索引里的原文', () => {
    for (const entry of entries) {
      expect(getPrivacyBoundaryEntryCopy(entry, 'zh')).toEqual({
        title: entry.title,
        summary: entry.summary,
        data: entry.data,
        storage: entry.storage,
        cloud: entry.cloud,
        revoke: entry.revoke,
        actionShortLabel: getPrivacyBoundaryActionShortLabel(entry),
      });
    }
  });

  it('英文界面：每个条目每个字段都有英文，不含中文，数据项个数与索引一致', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const copy = getPrivacyBoundaryEntryCopy(entry, 'en');
      expect(copy, entry.id).toBeTruthy();
      expect(copy.data.length, entry.id).toBe(entry.data.length);
      for (const text of [copy.title, copy.summary, ...copy.data, copy.storage, copy.cloud, copy.revoke, copy.actionShortLabel]) {
        expect(text.trim().length, entry.id).toBeGreaterThan(0);
        expect(text, entry.id).not.toMatch(HAN);
      }
    }
  });

  it('英文文案里没有索引已经不存在的条目', () => {
    const ids = new Set<string>(entries.map((entry) => entry.id));
    expect(Object.keys(privacyBoundaryIndexEn).filter((id) => !ids.has(id))).toEqual([]);
  });
});
