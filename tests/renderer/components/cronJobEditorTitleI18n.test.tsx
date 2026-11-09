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
const HAN_ESCAPE_RE = /\\u(?:4[e-f]|[5-8][0-9a-f]|9[0-9a-f])[0-9a-f]{2}/i;

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
    const heading = screen.getByRole('heading', { name: cc.pickTitle });
    expect(heading.textContent).toBe(cc.pickTitle);
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
    const heading = screen.getByRole('heading', { name: cc.fillTitleFallback });
    expect(heading.textContent).toBe(cc.fillTitleFallback);
    if (language === 'en') expect(heading.textContent).not.toMatch(HAN_RE);
    else expect(heading.textContent).toBe('填写参数');
    console.log(`${language} fill fallback heading textContent=${heading.textContent}`);
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
    expect(statement).toContain('cc.pickTitle');
    const code = statement.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(HAN_RE);
    expect(code).not.toMatch(HAN_ESCAPE_RE);
    console.log(`const title extracted statement length=${statement.length}`);
  });
});
