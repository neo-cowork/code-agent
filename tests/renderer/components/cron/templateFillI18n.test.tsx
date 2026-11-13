// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cronCenterEn, cronCenterZh } from '../../../../src/renderer/i18n/cronCenter';

vi.mock('../../../../src/renderer/hooks/useMcpServerStates', () => ({ useMcpServerStates: () => [] }));
vi.mock('../../../../src/renderer/components/features/cron/useChannelCatalog', () => ({
  useChannelCatalog: () => ({ accounts: [], accountsLoading: false, conversationsByAccount: {} }),
  useEventScheduleNames: () => () => ({}),
}));
vi.mock('../../../../src/renderer/components/features/cron/useMailSources', () => ({
  useMailSources: () => ({ state: { status: 'empty', accounts: [], mailboxesByAccount: {} }, reload: vi.fn() }),
}));

import { CronJobEditor } from '../../../../src/renderer/components/features/cron/CronJobEditor';
import * as templates from '../../../../src/renderer/components/features/cron/cronTemplates';
import { useAppStore } from '../../../../src/renderer/stores/appStore';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const cases = [
  {
    id: 'web-change-watch',
    zh: [['网页地址', '粘贴要关注的网页地址'], ['查看频率', '例如：每天 9:00、每 2 小时']],
    en: [['Web page URL', 'Paste the URL of the web page to watch'], ['Check frequency', 'For example: every day at 9:00, every 2 hours']],
    required: ['url'],
  },
  {
    id: 'feishu-calendar-conflict',
    zh: [['日历 ID', '飞书日历的 calendar_id（分享链接或调试台里取）'], ['查看频率', '例如：每天 9:00、每 2 小时']],
    en: [['Calendar ID', 'Paste the Feishu calendar ID from its sharing link'], ['Check frequency', 'For example: every day at 9:00, every 2 hours']],
    required: ['calendarId'],
  },
  {
    id: 'feishu-table-change',
    zh: [['Base App Token', '多维表格的 app_token'], ['数据表 ID', 'table_id（tbl 开头）'], ['查看频率', '例如：每天 9:00']],
    en: [['Base App Token', 'Paste the app token of the Feishu Base'], ['Table ID', 'Paste the table ID (starts with tbl)'], ['Check frequency', 'For example: every day at 9:00']],
    required: ['baseAppToken', 'tableId'],
  },
  {
    id: 'group-listen',
    zh: [['要做什么', '例如：有人提到发布就总结给我']],
    en: [['What should it do?', 'For example: summarize messages that mention a release']],
    required: ['task'],
  },
];

function open(id: string, language: 'en' | 'zh'): void {
  useAppStore.setState({ language });
  const cc = language === 'en' ? cronCenterEn.cronCenter : cronCenterZh.cronCenter;
  render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
  fireEvent.click(screen.getByRole('button', { name: cc.fromTemplate }));
  const template = templates.CRON_TEMPLATES.find((item) => item.id === id)!;
  fireEvent.click(screen.getByRole('button', { name: new RegExp(templates.getTemplateDisplayCopy(template, cc.templates).name) }));
}

function noCjk(): void {
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).not.toMatch(CJK);
  for (const element of Array.from(dialog.querySelectorAll('*'))) {
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      expect(element.getAttribute(attribute) ?? '').not.toMatch(CJK);
    }
  }
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
  vi.restoreAllMocks();
});

describe('CronJobEditor selectedTemplate.fields.map fill step', () => {
  for (const language of ['en', 'zh'] as const) {
    it.each(cases)(`${language} $id labels/placeholders and required errors preserve localized copy`, (entry) => {
      open(entry.id, language);
      const cc = language === 'en' ? cronCenterEn.cronCenter : cronCenterZh.cronCenter;
      const fields = entry[language];
      for (const [label, placeholder] of fields) {
        const input = screen.getByPlaceholderText(placeholder);
        const labelElement = screen.getByText(label, { selector: 'label' });
        expect(labelElement.parentElement?.contains(input)).toBe(true);
        expect(labelElement?.childNodes[0].textContent).toBe(label);
        expect(labelElement?.textContent).toBe(label + (entry.required.includes(
          templates.CRON_TEMPLATES.find((t) => t.id === entry.id)!.fields[fields.findIndex((f) => f[0] === label)].key,
        ) ? '*' : ''));
      }
      if (language === 'en') noCjk();
      fireEvent.click(screen.getByRole('button', { name: cc.editorChrome.createTask }));
      const requiredLabels = templates.CRON_TEMPLATES.find((t) => t.id === entry.id)!.fields
        .flatMap((field, index) => field.required ? [fields[index][0]] : []);
      const message = cc.editorChrome.requiredFieldsError.replace('{fields}', requiredLabels.join(cc.editorChrome.fieldListSeparator));
      expect(screen.getByText(message)).toBeTruthy();
      if (language === 'en') noCjk();
      console.log(`${language} ${entry.id} fields=${JSON.stringify(fields)} requiredError=${message}; zero CJK=${language === 'en'}`);
      // Exercise the reactive required-error path as each required field is filled.
      for (const [index, field] of templates.CRON_TEMPLATES.find((t) => t.id === entry.id)!.fields.entries()) {
        if (field.required) fireEvent.change(screen.getByPlaceholderText(fields[index][1]), { target: { value: 'watch releases' } });
        if (language === 'en') noCjk();
      }
      expect(screen.queryByText(message)).toBeNull();
    });
  }

  it('falls back to the original object copy when a field translation is absent', () => {
    const original = templates.getTemplateDisplayCopy;
    vi.spyOn(templates, 'getTemplateDisplayCopy').mockImplementation((template, localized) => {
      const { fields: _fields, ...copy } = original(template, localized);
      return copy;
    });
    open('web-change-watch', 'en');
    expect(screen.getByText('网页地址')).toBeTruthy();
    expect(screen.getByPlaceholderText('粘贴要关注的网页地址')).toBeTruthy();
  });
});
