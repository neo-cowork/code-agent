// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RolePanelDetail } from '../../../src/shared/contract/roleAssets';

const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => invokeDomain(...args), on: () => () => {} },
}));
vi.mock('../../../src/renderer/services/libraryClient', () => ({ listLibraryItems: () => Promise.resolve([]) }));
import { RoleDetailPage } from '../../../src/renderer/components/features/expert/RoleDetailPage';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { expertZh, expertEn } from '../../../src/renderer/i18n/expert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
const config = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../src/host/config/configPaths', () => ({ getUserConfigDir: () => config.dir }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
import { writeScopedMemory, listScopedMemories } from '../../../src/host/services/roleAssets/roleAssetService';
import { formatRoleHistoryLine } from '../../../src/renderer/components/features/expert/roleHistoryPresentation';

beforeEach(async () => { config.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'records-page-')); });
afterEach(async () => { cleanup(); vi.clearAllMocks(); useAppStore.setState({ language: 'zh' }); await fs.rm(config.dir, { recursive: true, force: true }); });

it.each([['zh', false], ['en', false], ['zh', true], ['en', true]] as const)('%s Records renders double-header memory and localized history (sanitized=%s)', async (language, sanitized) => {
  const target = { scope: 'role' as const, roleId: 'reporter' };
  const body = 'Weekly numbers use WAC and the new-signup rate.';
  const file = await writeScopedMemory(target, { filename: 'reporting.md', name: 'Reporting convention', description: 'Weekly definitions', content: body });
  await fs.writeFile(file, (await fs.readFile(file, 'utf-8')).replace(body, '---\nname: model title\ntype: reference\n---\n\n' + body));
  const history = ['advance', 'report', 'suggest'].map((decision) => sanitized ? `2026-11-12 [${decision}] Definitions aligned` : `- 2026-11-12 | Weekly reporting | [${decision}] Definitions aligned`);
  const detail: RolePanelDetail = {
    roleId: 'reporter', definition: null, definitionPath: '', history,
    proactivity: { level: 'silent' }, visual: { displayName: 'Reporter' }, isBuiltin: false,
    personalization: { userExpectation: '', soul: '', boundaries: { disallowExternalSending: false } },
    memories: await listScopedMemories(target),
  };
  invokeDomain.mockImplementation((_domain: string, action: string) => Promise.resolve(action === 'detail' ? structuredClone(detail) : []));
  useAppStore.setState({ language });
  render(<RoleDetailPage roleId="reporter" />);
  fireEvent.click(await screen.findByTestId('role-detail-tab-records'));
  const records = screen.getByTestId('role-detail-records-tab');
  expect(within(records).getByText(body)).toBeTruthy();
  expect(within(records).getByText('Weekly definitions')).toBeTruthy();
  expect(within(records).getByText('reporting.md')).toBeTruthy();
  for (const raw of ['---', 'type:', 'name:', '[advance]', '[report]', '[suggest]']) expect(records.textContent).not.toContain(raw);
  const copy = (language === 'zh' ? expertZh : expertEn).expert.roleDetail.historyDecision;
  for (const label of Object.values(copy)) expect(records.textContent).toContain(label + ' Definitions aligned');
  expect(screen.getByTestId('role-training-summary').textContent).toContain(copy.suggest + ' Definitions aligned');
  expect(detail.history).toEqual(history);
});

it('preserves tags outside the summary prefix', () => {
  const copy = expertEn.expert.roleDetail.historyDecision;
  for (const line of ['User quoted [advance] here', '- 2026-11-12 | [report] label | Ordinary text', '- 2026-11-12 | Work | User quoted [suggest]', '[unknown] Text']) expect(formatRoleHistoryLine(line, copy)).toBe(line);
  expect(formatRoleHistoryLine('[advance] Done', copy)).toBe('Advanced Done');
});
