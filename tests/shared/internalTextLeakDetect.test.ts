import { describe, expect, it } from 'vitest';
import { detectInternalTextLeaks } from '../../src/shared/internalTextLeakDetect';
import { humanizeInternalText } from '../../src/shared/humanizeInternalText';

describe('render language and catalog leak detection', () => {
  it.each(['weekly-report-synthesis', 'computer-use', 'meeting-summary'])(
    'detects catalog id %s inside runtime-built prose', (slug) => {
      expect(detectInternalTextLeaks(`Used ${slug}`)).toContainEqual({ format: 'catalog_slug', sample: slug });
    },
  );
  it('detects a catalog id before sentence punctuation without renaming a user file', () => {
    expect(detectInternalTextLeaks('Used weekly-report-synthesis.')).toContainEqual({ format: 'catalog_slug', sample: 'weekly-report-synthesis' });
  });
  it('detects Chinese chrome in English renders, with an explicit language', () => {
    expect(detectInternalTextLeaks('Report ready 已完成', 'en')).toEqual([{ format: 'cjk_in_en_ui', sample: '已完成' }]);
    expect(detectInternalTextLeaks('Report ready', 'en')).toEqual([]);
    expect(detectInternalTextLeaks('已完成', 'zh')).toEqual([]);
    expect(detectInternalTextLeaks('已完成')).toEqual([]);
  });
  it.each(['my-custom-skill', 'weekly report synthesis', 'weekly-report-synthesis-extra', 'weekly-report-synthesis.md'])(
    'keeps ordinary/user names and longer tokens: %s', (text) => {
      expect(detectInternalTextLeaks(text)).toEqual([]);
    },
  );
  it('detects untranslated completion receipts in Chinese chrome', () => {
    expect(detectInternalTextLeaks('Used a skill Done', 'zh')).toContainEqual({ format: 'english_state_word', sample: 'Done' });
    expect(detectInternalTextLeaks('Done', 'en')).toEqual([]);
  });
  it('still detects internal tool names alongside catalog names', () => {
    expect(detectInternalTextLeaks('read_file weekly-report-synthesis').map((hit) => hit.format))
      .toEqual(['catalog_slug', 'internal_tool_name']);
  });
  // N-FIX-HUMANIZE-TEMP-PATH-PRIVATE-PREFIX-LEFTOVER：/private 前缀必须被同一个 temp_path
  // match 整体吃掉（检测与 humanize 共用 internalTextLeakPatterns.json 的 tempPath 正则）。
  it('detects a /private/var/folders upload path as one temp_path hit whose sample starts with /private', () => {
    const input = '/private/var/folders/xx/yyyy/T/a/b.txt';
    const leaks = detectInternalTextLeaks(input);
    expect(leaks).toEqual([{ format: 'temp_path', sample: input }]);
    expect(leaks[0]?.sample.startsWith('/private')).toBe(true);
  });
  it('detects a /private/var/tmp path through the same shared tempPath regex', () => {
    const input = '/private/var/tmp/neo-upload/r.pdf';
    expect(detectInternalTextLeaks(input)).toContainEqual({ format: 'temp_path', sample: input });
  });
  it('humanize round-trip of the /private/var/folders sample leaves no temp_path leak', () => {
    const input = '/private/var/folders/xx/yyyy/T/a/b.txt';
    expect(detectInternalTextLeaks(humanizeInternalText(input, 'zh').text)).toEqual([]);
    expect(detectInternalTextLeaks(humanizeInternalText(input, 'en').text)).toEqual([]);
  });
});
