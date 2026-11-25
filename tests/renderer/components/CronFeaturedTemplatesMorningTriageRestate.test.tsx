// @vitest-environment jsdom
// ============================================================================
// CronFeaturedTemplates · 晨间分诊一键开启保存前复述卡（N-CRON-MORNING-TRIAGE-REST2）
// 点击晨间分诊推荐卡的「开启」不直接 createJob，先在 Modal 中复用 REST1 的
// PendingRoutineRestate 展示四行复述（做什么 / 什么时候 / 什么变化值得通知 /
// 结果送到哪里）：
// - 「确认保存」才调用 createJob 一次；
// - 「返回修改」/ Esc / 遮罩 / X 关闭卡片，createJob 为 0 次、不落库；
// - 云端未配置时「改在本机运行」直接走 local 创建一次，不再弹第二张确认卡；
// - 其余推荐卡与已暂停晨间分诊的重新开启（updateJob）保持原有直通行为。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { CRON_CLOUD_NOT_CONFIGURED } from '../../../src/shared/constants/cronErrors';

const mocks = vi.hoisted(() => ({
  createJob: vi.fn(),
  updateJob: vi.fn(),
}));

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    createJob: (input: unknown) => mocks.createJob(input),
    updateJob: (id: string, input: unknown) => mocks.updateJob(id, input),
  },
}));

vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => [],
}));

vi.mock('../../../src/renderer/components/features/cron/useChannelCatalog', () => ({
  useChannelCatalog: () => ({
    accounts: [],
    accountsLoading: false,
    conversationsByAccount: {},
  }),
}));

vi.mock('../../../src/renderer/components/features/cron/useArchiveProjectName', () => ({
  useArchiveProjectName: () => undefined,
}));

vi.mock('../../../src/renderer/components/features/cron/useScheduleEstimateHistory', () => ({
  useScheduleEstimateHistory: () => null,
}));

import { CronFeaturedTemplates } from '../../../src/renderer/components/features/cron/CronFeaturedTemplates';
import { CRON_TEMPLATES } from '../../../src/renderer/components/features/cron/cronTemplates';
import { buildCronJobInput } from '../../../src/renderer/components/features/cron/types';
import { chatInputEn, chatInputZh } from '../../../src/renderer/i18n/chatInput';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

function getPendingRowKeys(): string[] {
  const card = screen.getByTestId('cron-pending-routine-restate');
  return Array.from(card.querySelectorAll('[data-pending-routine-row]')).map(
    (el) => el.getAttribute('data-pending-routine-row') ?? '',
  );
}

function getPendingRowValue(key: string): string {
  const card = screen.getByTestId('cron-pending-routine-restate');
  return card.querySelector(`[data-pending-routine-value="${key}"]`)?.textContent ?? '';
}

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
  useCronStore.setState({
    jobs: [],
    stats: null,
    latestExecutions: {},
    executionsByJobId: {},
    selectedJobId: null,
    isLoading: false,
    isEditorOpen: false,
    editingJobId: null,
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAppStore.setState({ language: 'zh' });
});

describe('CronFeaturedTemplates · morning-triage 保存前复述确认卡', () => {
  it('点击晨间分诊「开启」先展示四行复述卡且不调用 createJob，确认后调用 createJob 一次', async () => {
    mocks.createJob.mockImplementation(async (input) => ({
      ...(input as object),
      id: 'job-morning-triage',
      createdAt: 1,
      updatedAt: 1,
    } as CronJobDefinition));

    render(<CronFeaturedTemplates />);
    fireEvent.click(screen.getByTestId('cron-featured-morning-triage'));

    const card = await screen.findByTestId('cron-pending-routine-restate');
    expect(card).toBeTruthy();
    expect(mocks.createJob).toHaveBeenCalledTimes(0);

    // 四行均存在：做什么（数据源+三档分诊规则）/ 什么时候 / 什么变化值得通知 / 结果送到哪里
    expect(getPendingRowKeys()).toEqual(['what', 'when', 'notifyWhen', 'result']);
    expect(getPendingRowValue('what')).toContain('未读邮件');
    expect(getPendingRowValue('what')).toContain('今天必须处理');
    expect(getPendingRowValue('when')).toContain('08:30');
    expect(getPendingRowValue('notifyWhen')).toBe(chatInputZh.scheduleConfirm.fallbackNotifyWhen);
    expect(getPendingRowValue('result')).toBe(chatInputZh.scheduleConfirm.reviewInbox);

    fireEvent.click(screen.getByTestId('cron-pending-routine-confirm'));

    await waitFor(() => {
      expect(mocks.createJob).toHaveBeenCalledTimes(1);
    });
    const submitted = mocks.createJob.mock.calls[0][0] as CronJobDefinition;
    expect(submitted.name).toBe('晨间分诊');
    expect(submitted.enabled).toBe(true);
    expect(submitted.schedule).toEqual({
      type: 'cron',
      expression: '30 8 * * 1-5',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(submitted.action.type).toBe('agent');
    if (submitted.action.type === 'agent') {
      expect(submitted.action.prompt).toContain('晨间分诊');
    }

    // 确认后卡片关闭
    await waitFor(() => {
      expect(screen.queryByTestId('cron-pending-routine-restate')).toBeNull();
    });
  });

  it('点击「返回修改」关闭复述卡，createJob 为 0 次且不创建任务', async () => {
    render(<CronFeaturedTemplates />);
    fireEvent.click(screen.getByTestId('cron-featured-morning-triage'));
    await screen.findByTestId('cron-pending-routine-restate');
    expect(mocks.createJob).toHaveBeenCalledTimes(0);

    fireEvent.click(screen.getByTestId('cron-pending-routine-back'));
    await waitFor(() => {
      expect(screen.queryByTestId('cron-pending-routine-restate')).toBeNull();
    });
    expect(mocks.createJob).toHaveBeenCalledTimes(0);
    expect(useCronStore.getState().jobs).toHaveLength(0);
    expect((screen.getByTestId('cron-featured-morning-triage') as HTMLButtonElement).disabled).toBe(false);
  });

  it('按 Esc 或点 Modal 关闭按钮关闭复述卡，createJob 均为 0 次', async () => {
    render(<CronFeaturedTemplates />);

    // Esc 关闭
    fireEvent.click(screen.getByTestId('cron-featured-morning-triage'));
    await screen.findByTestId('cron-pending-routine-restate');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('cron-pending-routine-restate')).toBeNull();
    });
    expect(mocks.createJob).toHaveBeenCalledTimes(0);

    // X 关闭按钮关闭
    fireEvent.click(screen.getByTestId('cron-featured-morning-triage'));
    await screen.findByTestId('cron-pending-routine-restate');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => {
      expect(screen.queryByTestId('cron-pending-routine-restate')).toBeNull();
    });
    expect(mocks.createJob).toHaveBeenCalledTimes(0);

    // 遮罩点击关闭
    fireEvent.click(screen.getByTestId('cron-featured-morning-triage'));
    await screen.findByTestId('cron-pending-routine-restate');
    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement?.firstElementChild as HTMLElement | null;
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    await waitFor(() => {
      expect(screen.queryByTestId('cron-pending-routine-restate')).toBeNull();
    });
    expect(mocks.createJob).toHaveBeenCalledTimes(0);
  });

  it('确认保存失败时在复述卡内展示错误信息且保留卡片', async () => {
    const failureReason = '定时任务创建失败，请稍后重试';
    mocks.createJob.mockRejectedValueOnce(new Error(failureReason));

    render(<CronFeaturedTemplates />);
    fireEvent.click(screen.getByTestId('cron-featured-morning-triage'));
    await screen.findByTestId('cron-pending-routine-restate');

    fireEvent.click(screen.getByTestId('cron-pending-routine-confirm'));

    await waitFor(() => {
      expect(mocks.createJob).toHaveBeenCalledTimes(1);
    });
    const card = screen.getByTestId('cron-pending-routine-restate');
    expect(card.textContent).toContain(failureReason);
  });

  it('云端未配置时展示通知，点「改在本机运行」直接以 runsOn: local 创建且不再弹第二张确认卡', async () => {
    const cloudErr = Object.assign(new Error('Cloud scheduler is not configured'), {
      code: CRON_CLOUD_NOT_CONFIGURED,
    });
    mocks.createJob
      .mockRejectedValueOnce(cloudErr)
      .mockImplementationOnce(async (input) => ({
        ...(input as object),
        id: 'job-morning-triage-local',
        createdAt: 2,
        updatedAt: 2,
      } as CronJobDefinition));

    render(<CronFeaturedTemplates />);
    fireEvent.click(screen.getByTestId('cron-featured-morning-triage'));
    await screen.findByTestId('cron-pending-routine-restate');

    // 第一次确认：触发云端未配置错误
    fireEvent.click(screen.getByTestId('cron-pending-routine-confirm'));
    const notice = await screen.findByTestId('cron-cloud-create-notice');
    expect(notice).toBeTruthy();
    expect(screen.queryByTestId('cron-pending-routine-restate')).toBeNull();
    expect(mocks.createJob).toHaveBeenCalledTimes(1);

    // 点击「改在本机运行」：直接 createJob(runsOn: 'local')，不再弹第二张复述卡
    const switchLocalBtn = notice.querySelector('button');
    expect(switchLocalBtn).toBeTruthy();
    fireEvent.click(switchLocalBtn!);

    await waitFor(() => {
      expect(mocks.createJob).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId('cron-pending-routine-restate')).toBeNull();
    const secondCall = mocks.createJob.mock.calls[1][0] as CronJobDefinition;
    expect(secondCall.runsOn).toBe('local');
    expect(secondCall.name).toBe('晨间分诊');
  });

  it('已暂停的晨间分诊重新开启走 updateJob，不弹复述卡；其他推荐模板仍一键直建', async () => {
    const morningTriage = CRON_TEMPLATES.find((t) => t.id === 'morning-triage')!;
    const pausedJob: CronJobDefinition = {
      ...buildCronJobInput(morningTriage.generate({}, 'zh')),
      id: 'existing-paused-morning-triage',
      enabled: false,
      createdAt: 1,
      updatedAt: 1,
    } as CronJobDefinition;
    useCronStore.setState({ jobs: [pausedJob] });
    mocks.updateJob.mockResolvedValue({ ...pausedJob, enabled: true });

    render(<CronFeaturedTemplates />);
    fireEvent.click(screen.getByTestId('cron-featured-morning-triage'));

    await waitFor(() => {
      expect(mocks.updateJob).toHaveBeenCalledWith('existing-paused-morning-triage', { enabled: true });
    });
    expect(mocks.createJob).toHaveBeenCalledTimes(0);
    expect(screen.queryByTestId('cron-pending-routine-restate')).toBeNull();
  });

  it('英文 UI 下复述卡四行与弹窗标题均展示英文', async () => {
    useAppStore.setState({ language: 'en' });
    render(<CronFeaturedTemplates />);
    fireEvent.click(screen.getByTestId('cron-featured-morning-triage'));

    const card = await screen.findByTestId('cron-pending-routine-restate');
    expect(card).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Morning triage' })).toBeTruthy();
    expect(getPendingRowKeys()).toEqual(['what', 'when', 'notifyWhen', 'result']);
    expect(getPendingRowValue('what')).toContain('morning triage');
    expect(getPendingRowValue('what')).toContain('Must handle today');
    expect(getPendingRowValue('when')).toContain('08:30');
    expect(getPendingRowValue('notifyWhen')).toBe(chatInputEn.scheduleConfirm.fallbackNotifyWhen);
    expect(getPendingRowValue('result')).toBe(chatInputEn.scheduleConfirm.reviewInbox);
    expect(mocks.createJob).toHaveBeenCalledTimes(0);
  });
});
