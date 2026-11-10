// @vitest-environment jsdom
// 推荐自动化模板的名称跟随 UI 语言；findExistingJob 对 zh/en 两种名称都认，
// 切换 UI 语言后不会把已开启的卡片当成「未开启」而重复创建。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

const createJob = vi.fn();

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    createJob: (input: unknown) => createJob(input),
    updateJob: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => [],
}));

import { CronFeaturedTemplates } from '../../../src/renderer/components/features/cron/CronFeaturedTemplates';
import { CRON_TEMPLATES } from '../../../src/renderer/components/features/cron/cronTemplates';
import { buildCronJobInput } from '../../../src/renderer/components/features/cron/types';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const dailyReview = CRON_TEMPLATES.find((template) => template.id === 'daily-review')!;

function storedJob(language: 'zh' | 'en'): CronJobDefinition {
  return {
    ...buildCronJobInput(dailyReview.generate({}, language)),
    id: `job-${language}`,
    createdAt: 1,
    updatedAt: 1,
  } as CronJobDefinition;
}

beforeEach(() => {
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

describe('推荐模板：名称跟随 UI 语言', () => {
  it('generate 缺省仍是中文；en 取英文词条，agentPrompt 不变', () => {
    expect(dailyReview.generate({}).name).toBe('每日回顾');
    const en = dailyReview.generate({}, 'en');
    expect(en.name).toBe('Daily review');
    expect(en.description).toBe('Review today’s progress and follow-ups');
    expect(en.agentPrompt).toBe(dailyReview.generate({}).agentPrompt);
  });

  it('英文 UI 开启「Daily review」存英文名；切到中文仍显示已开启、不重复创建', async () => {
    useAppStore.setState({ language: 'en' });
    createJob.mockImplementation(async (input) => ({ ...(input as object), id: 'job-en', createdAt: 1, updatedAt: 1 }));
    const { rerender } = render(<CronFeaturedTemplates />);
    fireEvent.click(screen.getByTestId('cron-featured-daily-review'));
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
    const submitted = createJob.mock.calls[0][0] as CronJobDefinition;
    expect(submitted.name).toBe('Daily review');

    useCronStore.setState({ jobs: [{ ...submitted, id: 'job-en', createdAt: 1, updatedAt: 1 }] });
    useAppStore.setState({ language: 'zh' });
    rerender(<CronFeaturedTemplates />);
    const button = screen.getByTestId('cron-featured-daily-review') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it('中文名的存量任务在英文 UI 下仍被认作已开启，不重复创建', () => {
    useCronStore.setState({ jobs: [storedJob('zh')] });
    useAppStore.setState({ language: 'en' });
    render(<CronFeaturedTemplates />);
    const button = screen.getByTestId('cron-featured-daily-review') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(createJob).not.toHaveBeenCalled();
  });
});
