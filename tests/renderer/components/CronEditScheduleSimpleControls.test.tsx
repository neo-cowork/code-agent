// @vitest-environment jsdom
// 编辑已有「每天/工作日/每周」任务时，调度区与创建页同款频率 + 时分下拉（FB-2504）。
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { compileSimpleSchedule, decompileSimpleSchedule } from '../../../src/renderer/components/features/cron/CronSimpleCreate';

vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({ useMcpServerStates: () => [] }));
vi.mock('../../../src/renderer/components/features/cron/useChannelCatalog', () => ({
  useChannelCatalog: () => ({ accounts: [], accountsLoading: false, conversationsByAccount: {} }),
  useEventScheduleNames: () => () => ({}),
}));
vi.mock('../../../src/renderer/components/features/cron/useMailSources', () => ({
  useMailSources: () => ({ state: { status: 'empty', accounts: [], mailboxesByAccount: {} }, reload: vi.fn() }),
}));

import CronJobEditor from '../../../src/renderer/components/features/cron/CronJobEditor';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { cronCenterEn } from '../../../src/renderer/i18n/cronCenter';

const updateJob = vi.fn();

function makeJob(expression: string): CronJobDefinition {
  return {
    id: 'job-edit-simple',
    name: 'Inbox reminder',
    description: '',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression, timezone: 'Asia/Tokyo' },
    action: { type: 'shell', command: 'echo hi', usePty: false },
    runsOn: 'local',
    maxRetries: 0,
    runCount: 0,
    enabled: true,
  } as unknown as CronJobDefinition;
}

function open(expression: string, language: 'zh' | 'en' = 'zh'): void {
  useAppStore.setState({ language });
  render(<CronJobEditor isOpen job={makeJob(expression)} onClose={() => undefined} />);
}

const sel = (id: string) => screen.getByTestId(id) as HTMLSelectElement;

beforeEach(() => {
  updateJob.mockReset();
  updateJob.mockResolvedValue(makeJob('37 14 * * *'));
  useCronStore.setState({ jobs: [], createJob: vi.fn(), updateJob });
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe('decompileSimpleSchedule', () => {
  it.each([
    { freq: 'daily', time: '13:37', weekday: '1' },
    { freq: 'weekdays', time: '09:05', weekday: '1' },
    { freq: 'weekly', time: '23:59', weekday: '0' },
    { freq: 'weekly', time: '00:00', weekday: '6' },
  ] as const)('is the inverse of compileSimpleSchedule for %o', (s) => {
    const { cronExpression } = compileSimpleSchedule({ ...s, intervalHours: '1', onceAt: '' });
    expect(decompileSimpleSchedule(cronExpression as string)).toEqual(s);
  });

  it.each(['*/15 9-17 * * 1-5', '0 9 * * 7', '0 9 1 * *', '0 9 * 1 *', '0,30 9 * * *', '0 9 * * 1,3', '0 24 * * *', '60 9 * * *', '0 0 9 * * *'])(
    'rejects %s', (expr) => expect(decompileSimpleSchedule(expr)).toBeNull());
});

describe('编辑调度：与创建页同款控件', () => {
  it('预填 13:37，改成 14:37 保存得到 37 14 * * * 且时区不变', async () => {
    open('37 13 * * *');
    expect(sel('cron-editor-time-hour').value).toBe('13');
    expect(sel('cron-editor-time-minute').value).toBe('37');
    expect(screen.queryByDisplayValue('37 13 * * *')).toBeNull();
    expect(screen.getByDisplayValue('Asia/Tokyo')).toBeTruthy();
    fireEvent.change(sel('cron-editor-time-hour'), { target: { value: '14' } });
    fireEvent.click(screen.getByText('保存修改'));
    fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));
    await vi.waitFor(() => expect(updateJob).toHaveBeenCalled());
    const [id, input] = updateJob.mock.calls[0];
    expect(id).toBe('job-edit-simple');
    expect(input.schedule).toMatchObject({ type: 'cron', expression: '37 14 * * *', timezone: 'Asia/Tokyo' });
  });

  it('每周预填星期，并带星期下拉', () => {
    open('0 9 * * 3');
    expect(screen.getByText('每周')).toBeTruthy();
    expect(screen.getByText('周三')).toBeTruthy();
  });

  it('自定义表达式保留 Cron 输入框 + 说明 + 可读预览（不回显原表达式），没有时分下拉', () => {
    open('*/15 9-17 * * 1-5');
    expect(screen.getByDisplayValue('*/15 9-17 * * 1-5')).toBeTruthy();
    expect(screen.queryByTestId('cron-editor-time')).toBeNull();
    expect(screen.getByTestId('cron-custom-hint')).toBeTruthy();
    const preview = screen.getByTestId('cron-custom-preview').textContent ?? '';
    expect(preview).toContain('执行时间说明：工作日 09:00–17:59 每 15 分钟');
    expect(preview).not.toContain('*/15');
    expect(screen.queryByTestId('cron-back-simple')).toBeNull();
  });

  it('英文自定义预览是一句人话', () => {
    open('*/15 9-17 * * 1-5', 'en');
    const preview = screen.getByTestId('cron-custom-preview').textContent ?? '';
    expect(preview).toContain('Runs: Every 15 minutes, 09:00–17:59, Mon–Fri');
    expect(preview).not.toContain('*/15');
  });

  it('点「使用自定义 Cron 表达式」不改写表达式，再点返回回到下拉', () => {
    open('37 13 * * *');
    fireEvent.click(screen.getByTestId('cron-use-custom'));
    expect(screen.getByDisplayValue('37 13 * * *')).toBeTruthy();
    fireEvent.click(screen.getByTestId('cron-back-simple'));
    expect(sel('cron-editor-time-hour').value).toBe('13');
  });

  it('英文界面渲染英文标签', () => {
    open('37 13 * * *', 'en');
    expect(screen.getByText(cronCenterEn.cronCenter.freqDaily)).toBeTruthy();
    expect(screen.getByText(cronCenterEn.cronCenter.simpleTimeLabel)).toBeTruthy();
    expect(screen.getByText(cronCenterEn.cronCenter.editorChrome.cronUseCustomLink)).toBeTruthy();
  });
});
