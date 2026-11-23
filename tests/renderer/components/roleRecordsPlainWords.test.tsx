// @vitest-environment jsdom
// 专家「记录」tab 与定时任务列表的大白话展示：无文件名行、无 Keywords 尾巴、
// 角色定时唤醒任务（存储名 `[Cadence] x`）显示成「定时唤醒」。
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoleBoundCronJob, RolePanelDetail } from '../../../src/shared/contract/roleAssets';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

const invokeDomain = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    invoke: () => Promise.resolve(undefined),
    on: () => () => {},
  },
}));
vi.mock('../../../src/renderer/services/libraryClient', () => ({ listLibraryItems: () => Promise.resolve([]) }));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    getGroupListenCheck: vi.fn().mockResolvedValue({ status: 'idle' }),
    startGroupListenCheck: vi.fn(),
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    grantWriteScope: vi.fn(),
    revokeWriteScope: vi.fn(),
  },
}));

import { RoleDetailPage } from '../../../src/renderer/components/features/expert/RoleDetailPage';
import { CronJobDetail } from '../../../src/renderer/components/features/cron/CronJobDetail';
import { CronJobList } from '../../../src/renderer/components/features/cron/CronJobList';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function detail(): RolePanelDetail {
  return {
    roleId: 'notes', definition: null, definitionPath: '', history: [],
    memories: [
      {
        filename: 'lead_with_conclusion.md', name: 'Lead with the conclusion',
        description: 'Weekly report structure rule. Keywords: report, weekly, conclusion',
        content: 'x', updatedAt: '2026-11-17',
      },
      {
        filename: 'zh_rule.md', name: '结论先行', description: '周报结构规则。关键词：周报，结论', content: 'x', updatedAt: '2026-11-17',
      },
    ],
    proactivity: { level: 'daily' }, visual: { displayName: 'Notes' }, isBuiltin: false,
    personalization: { userExpectation: '', soul: '', boundaries: { disallowExternalSending: false } },
  } as unknown as RolePanelDetail;
}

const wakeJob: RoleBoundCronJob = {
  id: 'wake-1', name: '[Cadence] notes', schedule: { type: 'cron', expression: '0 8 * * *' },
  enabled: true, nextRunAt: 0, actionType: 'role_wake',
};

function cronDef(): CronJobDefinition {
  return {
    id: 'job-w', runsOn: 'local', name: '[Cadence] notes', scheduleType: 'cron',
    schedule: { type: 'cron', expression: '0 8 * * *' },
    action: { type: 'role-wake', roleId: 'notes' } as CronJobDefinition['action'],
    enabled: true, maxRetries: 0, createdAt: 1, updatedAt: 1,
  } as CronJobDefinition;
}

describe.each([['zh', '定时唤醒'], ['en', 'Scheduled wake-up']] as const)('records tab plain words (%s)', (language, label) => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); useAppStore.setState({ language: 'zh' }); });

  it('③ memory rows: no file-name row, Keywords tail stripped; automation row plain label', async () => {
    useAppStore.setState({ language });
    invokeDomain.mockImplementation((_d: string, action: string) => Promise.resolve(
      action === 'detail' ? detail() : action === 'listBoundCronJobs' ? [wakeJob] : [],
    ));
    render(<RoleDetailPage roleId="notes" />);
    fireEvent.click(await screen.findByTestId('role-detail-tab-records'));
    const records = await screen.findByTestId('role-detail-records-tab');
    const text = records.textContent ?? '';
    expect(within(records).getByText('Weekly report structure rule')).toBeTruthy();
    expect(within(records).getByText('周报结构规则')).toBeTruthy();
    expect(text).not.toContain('report, weekly');
    expect(text).not.toContain('周报，结论');
    expect(text).not.toMatch(/Keywords:|关键词：/);
    expect(text).not.toContain('lead_with_conclusion.md');
    expect(text).not.toContain('zh_rule.md');
    const row = await screen.findByTestId('role-bound-automation-wake-1');
    expect(row.textContent).toContain(label);
    expect(row.textContent).not.toContain('Cadence');
    expect(row.textContent).not.toContain('[');
  });

  it('③ cron detail and list show the same plain label for a [Cadence] job', () => {
    useAppStore.setState({ language });
    const { unmount } = render(<CronJobDetail job={cronDef()} />);
    const header = screen.getByTestId('cron-job-detail').textContent ?? '';
    expect(header).toContain(`${label} · notes`);
    expect(header).not.toContain('[Cadence]');
    unmount();
    useCronStore.setState({ jobs: [cronDef()] });
    render(<CronJobList />);
    expect(document.body.textContent).toContain(`${label} · notes`);
    expect(document.body.textContent).not.toContain('[Cadence]');
  });
});
