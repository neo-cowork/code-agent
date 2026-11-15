import { describe, expect, it } from 'vitest';
import { detectInternalTextLeaks } from '../../src/shared/internalTextLeakDetect';

describe('render language and catalog leak detection', () => {
  it.each(['weekly-report-synthesis', 'computer-use', 'meeting-summary'])(
    'detects catalog id %s inside runtime-built prose', (slug) => {
      expect(detectInternalTextLeaks(`Used ${slug}`)).toContainEqual({ format: 'catalog_slug', sample: slug });
    },
  );
  it('detects Chinese chrome in English renders, with an explicit language', () => {
    expect(detectInternalTextLeaks('Report ready 已完成', 'en')).toEqual([{ format: 'cjk_in_en_ui', sample: '已完成' }]);
    expect(detectInternalTextLeaks('Report ready', 'en')).toEqual([]);
    expect(detectInternalTextLeaks('已完成', 'zh')).toEqual([]);
    expect(detectInternalTextLeaks('已完成')).toEqual([]);
  });
  it.each(['my-custom-skill', 'weekly report synthesis', 'weekly-report-synthesis-extra', 'weekly-report-synthesis.md'])(
    'keeps ordinary/user names and longer tokens: %s', (text) => {
      // A filename with a catalog id still exposes that id; arbitrary slugs do not.
      expect(detectInternalTextLeaks(text).some((hit) => hit.format === 'catalog_slug')).toBe(text.endsWith('.md'));
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
});
