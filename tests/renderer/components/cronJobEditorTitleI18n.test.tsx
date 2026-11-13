// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cronCenterEn, cronCenterZh } from '../../../src/renderer/i18n/cronCenter';

vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => [],
}));
vi.mock('../../../src/renderer/components/features/cron/useChannelCatalog', () => ({
  useChannelCatalog: () => ({ accounts: [], accountsLoading: false, conversationsByAccount: {} }),
  useEventScheduleNames: () => () => ({}),
}));
vi.mock('../../../src/renderer/components/features/cron/useMailSources', () => ({
  useMailSources: () => ({
    state: { status: 'empty', accounts: [], mailboxesByAccount: {} },
    reload: vi.fn(),
  }),
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import * as templates from '../../../src/renderer/components/features/cron/cronTemplates';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const HAN_RE = /\p{Script=Han}/u;
const UNICODE_ESCAPE_RE = /\\u([0-9a-f]{4})/gi;

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
  vi.restoreAllMocks();
});

function openTemplatePicker(language: 'en' | 'zh'): void {
  useAppStore.setState({ language });
  render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
  const cc = language === 'en' ? cronCenterEn.cronCenter : cronCenterZh.cronCenter;
  fireEvent.click(screen.getByRole('button', { name: cc.fromTemplate }));
}

describe('CronJobEditor template title i18n', () => {
  it.each([
    ['en', cronCenterEn.cronCenter],
    ['zh', cronCenterZh.cronCenter],
  ] as const)('pick heading uses localized copy in %s', (language, cc) => {
    openTemplatePicker(language);
    const heading = screen.getByRole('heading', { name: cc.editorChrome.selectTemplateTitle });
    expect(heading.textContent).toBe(cc.editorChrome.selectTemplateTitle);
    if (language === 'en') expect(heading.textContent).not.toMatch(HAN_RE);
    else expect(heading.textContent).toBe('选择任务模板');
    console.log(`${language} pick heading textContent=${heading.textContent}`);
  });

  it.each([
    ['en', cronCenterEn.cronCenter],
    ['zh', cronCenterZh.cronCenter],
  ] as const)('fill heading keeps the localized template name in %s', (language, cc) => {
    openTemplatePicker(language);
    const copy = templates.getTemplateDisplayCopy(templates.CRON_TEMPLATES[0], cc.templates);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.name) }));
    const heading = screen.getByRole('heading', { name: copy.name });
    expect(heading.textContent).toBe(copy.name);
    if (language === 'en') expect(heading.textContent).not.toMatch(HAN_RE);
  });

  it.each([
    ['en', cronCenterEn.cronCenter],
    ['zh', cronCenterZh.cronCenter],
  ] as const)('fill fallback heading uses localized copy for an empty display name in %s', (language, cc) => {
    const original = templates.getTemplateDisplayCopy;
    vi.spyOn(templates, 'getTemplateDisplayCopy').mockImplementation((template, localized) => ({
      ...original(template, localized), name: '',
    }));
    openTemplatePicker(language);
    const copy = original(templates.CRON_TEMPLATES[0], cc.templates);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.description) }));
    const heading = screen.getByRole('heading', { name: cc.editorChrome.fillTemplateTitle });
    expect(heading.textContent).toBe(cc.editorChrome.fillTemplateTitle);
    if (language === 'en') expect(heading.textContent).not.toMatch(HAN_RE);
    else expect(heading.textContent).toBe('填写参数');
    console.log(`${language} fill fallback heading textContent=${heading.textContent}`);
  });

  it('en template picker dialog contains no Han characters for any template', () => {
    openTemplatePicker('en');
    const dialog = screen.getByRole('dialog');
    expect(templates.CRON_TEMPLATES.length).toBeGreaterThan(0);
    expect(dialog.textContent).toContain(cronCenterEn.cronCenter.editorChrome.skipTemplate);
    expect(dialog.textContent).not.toMatch(HAN_RE);
    console.log(`en picker dialog textContent length=${dialog.textContent?.length}, templates=${templates.CRON_TEMPLATES.length}`);
  });

  it('zh template picker keeps the original Chinese card copy', () => {
    openTemplatePicker('zh');
    const text = screen.getByRole('dialog').textContent ?? '';
    for (const expected of ['网页更新提醒', '飞书日程冲突监听', '飞书表格行变更监听', '飞书', '跳过模板，手动配置']) {
      expect(text).toContain(expected);
    }
  });

  it('source gate covers the whole const title statement without Han literals or escapes', () => {
    const source = readFileSync(path.resolve(__dirname,
      '../../../src/renderer/components/features/cron/CronJobEditor.tsx'), 'utf8');
    const file = ts.createSourceFile('CronJobEditor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const statements: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isVariableStatement(node) && node.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'title',
      )) statements.push(node.getText(file));
      ts.forEachChild(node, visit);
    }
    visit(file);
    expect(statements).toHaveLength(1);
    const statement = statements[0];
    expect(statement.length).toBeGreaterThan(0);
    expect(statement).toMatch(/^const title\s*=/);
    expect(statement.endsWith(';')).toBe(true);
    expect(statement).toContain('cc.editorChrome.selectTemplateTitle');
    const code = statement.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(HAN_RE);
    const decoded = code.replace(UNICODE_ESCAPE_RE, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    expect(decoded).not.toMatch(HAN_RE);
    console.log(`const title extracted statement length=${statement.length}`);
  });
});
