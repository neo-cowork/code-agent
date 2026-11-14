// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { CronJobDefinition, CronJobExecution } from '../../../src/shared/contract';

const notificationHooks = vi.hoisted(() => ({
  show: null as null | ((e: unknown) => void),
  click: null as null | ((e: { payload: { id: string; sessionId?: string } }) => void),
}));

vi.mock('../../../src/renderer/services/cronClient', () => {
  const client = {
    listJobs: vi.fn(),
    getStats: vi.fn().mockResolvedValue({ activeJobs: 2, totalJobs: 2, successRate: 100, jobsByStatus: { running: 0 } }),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
    deleteJob: vi.fn(),
    updateJob: vi.fn(),
    triggerJob: vi.fn(),
    createJob: vi.fn(),
    grantWriteScope: vi.fn(),
    revokeWriteScope: vi.fn(),
  };
  return { cronClient: client, default: client };
});

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn().mockResolvedValue(undefined),
    invoke: vi.fn().mockResolvedValue([]),
    on: vi.fn((channel: string, cb: (e: unknown) => void) => {
      if (channel === IPC_CHANNELS.NOTIFICATION_SHOW) notificationHooks.show = cb;
      return () => undefined;
    }),
  },
  invokeDomain: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  listenTauriEvent: vi.fn(async (_name: string, cb: (e: { payload: { id: string; sessionId?: string } }) => void) => {
    notificationHooks.click = cb;
    return () => undefined;
  }),
}));

vi.mock('../../../src/renderer/utils/osNotification', () => ({
  postOsNotification: vi.fn(async () => undefined),
  registerNotificationClick: vi.fn(async () => async () => undefined),
  reportNotificationHandled: vi.fn(),
}));

vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: {
    listParkedApprovals: vi.fn().mockResolvedValue([]),
    listPendingReview: vi.fn().mockResolvedValue([]),
    countPendingReview: vi.fn().mockResolvedValue(0),
    listAwaitingApprovalRuns: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../../src/renderer/components/features/cron/CronJobEditor', () => ({
  CronJobEditor: () => null,
}));

vi.mock('../../../src/renderer/components/features/cron/CronFeaturedTemplates', () => ({
  CronFeaturedTemplates: () => null,
}));

vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({
  WebModeBanner: () => null,
}));

import { CronCenterPanel } from '../../../src/renderer/components/features/cron/CronCenterPanel';
import { useCronOsNotification } from '../../../src/renderer/hooks/useCronOsNotification';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { cronClient } from '../../../src/renderer/services/cronClient';

function makeJob(overrides: Partial<CronJobDefinition> & Pick<CronJobDefinition, 'id' | 'name'>): CronJobDefinition {
  return {
    enabled: true,
    runsOn: 'local',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '0 9 * * *' },
    action: { type: 'agent', agentType: 'default', prompt: `Run ${overrides.name}` },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeExecution(jobId: string, id = `exec-${jobId}`): CronJobExecution {
  return {
    id,
    jobId,
    status: 'completed',
    scheduledAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_005_000,
    duration: 5_000,
    retryAttempt: 0,
    result: {
      agentType: 'default',
      prompt: `Run ${jobId}`,
      sessionId: `sess-${jobId}`,
      digest: { summary: `Run summary for ${jobId}` },
    },
  };
}

const memoryCleanupJob = makeJob({
  id: 'job-memory',
  name: '记忆整理',
  description: '定期整理你的记忆文件',
});

const drinkWaterJob = makeJob({
  id: 'job-water',
  name: '喝水提醒',
  description: '每小时提醒喝水',
});

const weeklySummaryJob = makeJob({
  id: 'job-weekly',
  name: '周报汇总',
  description: '每周五汇总进展',
  tags: ['提醒'],
});

let jobsInBackend: CronJobDefinition[] = [];

function expectEmptyDetailWithoutActions() {
  expect(screen.getByText('选择一个任务查看详情')).toBeTruthy();
  expect(screen.queryByTestId('cron-job-detail')).toBeNull();
  expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  expect(screen.queryByRole('button', { name: '停用' })).toBeNull();
  expect(screen.queryByRole('button', { name: '启用' })).toBeNull();
  expect(screen.queryByRole('button', { name: '手动触发' })).toBeNull();
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
}

beforeEach(() => {
  jobsInBackend = [memoryCleanupJob, drinkWaterJob, weeklySummaryJob];
  notificationHooks.show = null;
  notificationHooks.click = null;

  vi.mocked(cronClient.listJobs).mockReset().mockImplementation(async (filter) => {
    if (!filter) return [...jobsInBackend];
    return jobsInBackend.filter((job) => job.enabled === filter.enabled);
  });
  vi.mocked(cronClient.getExecutions).mockReset().mockImplementation(async (jobId) => [makeExecution(jobId)]);
  vi.mocked(cronClient.deleteJob).mockReset().mockImplementation(async (jobId) => {
    jobsInBackend = jobsInBackend.filter((job) => job.id !== jobId);
    return true;
  });

  useAppStore.setState({ language: 'zh', showCronCenter: true, cronCenterRunsRequested: false });
  useSessionStore.setState({ sessions: [] });
  useCronStore.setState({
    jobs: [],
    allJobs: [],
    jobNamesLoaded: false,
    stats: null,
    latestExecutions: {},
    executionsByJobId: {},
    recentExecutions: [],
    selectedJobId: null,
    filterMode: 'all',
    locationFilter: 'all',
    searchQuery: '',
    isLoading: false,
    isEditorOpen: false,
    editingJobId: null,
    copyingJobId: null,
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('CronCenterPanel visible-list detail invariant (FB-1428)', () => {
  it('non-existent search clears detail and removes Edit/Disable/Run now/Delete and run records from DOM', async () => {
    render(<CronCenterPanel onClose={() => undefined} />);

    const detail = await screen.findByTestId('cron-job-detail');
    expect(within(detail).getByRole('heading', { name: '记忆整理' })).toBeTruthy();
    await waitFor(() => expect(within(detail).getByText('Run summary for job-memory')).toBeTruthy());
    expect(within(detail).getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(within(detail).getByRole('button', { name: '停用' })).toBeTruthy();
    expect(within(detail).getByRole('button', { name: '手动触发' })).toBeTruthy();
    expect(within(detail).getByRole('button', { name: '删除' })).toBeTruthy();

    const searchInput = screen.getByPlaceholderText('搜索任务名、描述、标签');
    fireEvent.change(searchInput, { target: { value: '不存在的任务名xyz' } });

    expect(screen.getByText('没有匹配的任务')).toBeTruthy();
    expectEmptyDetailWithoutActions();
    expect(screen.queryByText('Run summary for job-memory')).toBeNull();
    expect(useCronStore.getState().selectedJobId).toBeNull();
  });

  it('deleting the only matching task clears detail without jumping to hidden tasks, and clearing search restores default selection', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CronCenterPanel onClose={() => undefined} />);

    await screen.findByTestId('cron-job-detail');
    await waitFor(() => expect(useCronStore.getState().isLoading).toBe(false));
    const searchInput = screen.getByPlaceholderText('搜索任务名、描述、标签');
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: '喝水提醒' } });
    });
    // Explicitly select the matched row in the list so even without auto-selection the FB-1428 delete->refresh->loadJobs fallback is isolated.
    await act(async () => {
      fireEvent.click(screen.getAllByText('喝水提醒')[0]);
    });

    const matchedDetail = await screen.findByTestId('cron-job-detail');
    expect(within(matchedDetail).getByRole('heading', { name: '喝水提醒' })).toBeTruthy();
    expect(useCronStore.getState().selectedJobId).toBe('job-water');

    await act(async () => {
      fireEvent.click(within(matchedDetail).getByRole('button', { name: '删除' }));
    });

    await waitFor(() => expect(cronClient.deleteJob).toHaveBeenCalledWith('job-water'));
    await waitFor(() => expect(useCronStore.getState().isLoading).toBe(false));

    expect(screen.getByText('没有匹配的任务')).toBeTruthy();
    expectEmptyDetailWithoutActions();
    expect(screen.queryByText('记忆整理')).toBeNull();
    expect(useCronStore.getState().selectedJobId).toBeNull();

    fireEvent.change(searchInput, { target: { value: '' } });

    const restoredDetail = await screen.findByTestId('cron-job-detail');
    expect(within(restoredDetail).getByRole('heading', { name: '记忆整理' })).toBeTruthy();
    expect(useCronStore.getState().selectedJobId).toBe('job-memory');
  });

  it('multi-match search keeps a visible selection, and narrowing out the selected task moves detail to the first visible match', async () => {
    render(<CronCenterPanel onClose={() => undefined} />);

    await screen.findByTestId('cron-job-detail');
    await waitFor(() => expect(useCronStore.getState().isLoading).toBe(false));
    const searchInput = screen.getByPlaceholderText('搜索任务名、描述、标签');

    // Both drinkWaterJob (name/desc contains 提醒) and weeklySummaryJob (tag 提醒) match '提醒',
    // while memoryCleanupJob is excluded -> selection moves to first visible ('喝水提醒').
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: '提醒' } });
    });
    expect(useCronStore.getState().selectedJobId).toBe('job-water');
    expect(within(screen.getByTestId('cron-job-detail')).getByRole('heading', { name: '喝水提醒' })).toBeTruthy();

    // User clicks the second visible match ('周报汇总'); keeping multi-match search preserves it.
    await act(async () => {
      fireEvent.click(screen.getByText('周报汇总'));
    });
    expect(useCronStore.getState().selectedJobId).toBe('job-weekly');
    expect(within(screen.getByTestId('cron-job-detail')).getByRole('heading', { name: '周报汇总' })).toBeTruthy();

    // Narrowing search to '喝水' excludes '周报汇总' -> selection moves to first visible ('喝水提醒').
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: '喝水' } });
    });
    expect(useCronStore.getState().selectedJobId).toBe('job-water');
    expect(within(screen.getByTestId('cron-job-detail')).getByRole('heading', { name: '喝水提醒' })).toBeTruthy();
  });

  it('location filter (cloud with only local jobs) clears detail and removes action buttons', async () => {
    render(<CronCenterPanel onClose={() => undefined} />);

    const detail = await screen.findByTestId('cron-job-detail');
    await waitFor(() => expect(useCronStore.getState().isLoading).toBe(false));
    expect(within(detail).getByRole('heading', { name: '记忆整理' })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('cron-location-filter-cloud'));
    });

    expect(screen.getByText('没有匹配的任务')).toBeTruthy();
    expectEmptyDetailWithoutActions();
    expect(useCronStore.getState().selectedJobId).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('cron-location-filter-all'));
    });
    const restored = await screen.findByTestId('cron-job-detail');
    expect(within(restored).getByRole('heading', { name: '记忆整理' })).toBeTruthy();
    expect(useCronStore.getState().selectedJobId).toBe('job-memory');
  });

  it('notification click targeting a hidden job clears searchQuery and resets locationFilter to all', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    const cloudJob = makeJob({ id: 'job-cloud', name: '云端日报', runsOn: 'cloud' });
    jobsInBackend = [memoryCleanupJob, cloudJob];

    renderHook(() => useCronOsNotification({} as never, vi.fn()));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    render(<CronCenterPanel onClose={() => undefined} />);
    await screen.findByTestId('cron-job-detail');
    await waitFor(() => expect(useCronStore.getState().isLoading).toBe(false));

    const searchInput = screen.getByPlaceholderText('搜索任务名、描述、标签');
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: '记忆' } });
      fireEvent.click(screen.getByTestId('cron-location-filter-local'));
    });
    expect(useCronStore.getState().searchQuery).toBe('记忆');
    expect(useCronStore.getState().locationFilter).toBe('local');
    expect(screen.queryByText('云端日报')).toBeNull();

    act(() => {
      notificationHooks.show?.({
        id: 'notif-cloud-1',
        title: '定时任务没跑成',
        body: '运行失败',
        jobId: 'job-cloud',
        failure: true,
      });
    });
    await act(async () => {
      notificationHooks.click?.({ payload: { id: 'notif-cloud-1' } });
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(useCronStore.getState().searchQuery).toBe('');
    expect(useCronStore.getState().locationFilter).toBe('all');
    expect(useCronStore.getState().selectedJobId).toBe('job-cloud');
    const detail = await screen.findByTestId('cron-job-detail');
    expect(within(detail).getByRole('heading', { name: '云端日报' })).toBeTruthy();
  });
});
