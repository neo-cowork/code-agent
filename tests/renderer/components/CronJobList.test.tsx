// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
  },
}));

import { CronJobList } from '../../../src/renderer/components/features/cron/CronJobList';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { MEMORY_CONSOLIDATION } from '../../../src/shared/constants/memory';

function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
  return {
    id: 'job-1',
    runsOn: 'local',
    name: '英语单词',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '30 8 * * *' },
    action: { type: 'agent', agentType: 'default', prompt: '每天推荐 5 个英语单词' },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  useCronStore.setState({
    jobs: [],
    stats: null,
    latestExecutions: {},
    executionsByJobId: {},
    selectedJobId: null,
    filterMode: 'all',
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
});

describe('CronJobList 人话副标题 + 触发源 chip', () => {
  it('cron 表达式副标题翻成「每天 08:30」，chip 显示定时', () => {
    useCronStore.setState({ jobs: [makeJob({})] });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-job-schedule-summary').textContent).toBe('每天 08:30');
    expect(screen.getByTestId('cron-job-trigger-kind').textContent).toBe('定时');
  });

  it('工作日形态：0 15 * * 1-5 → 工作日 15:00', () => {
    useCronStore.setState({
      jobs: [makeJob({ schedule: { type: 'cron', expression: '0 15 * * 1-5' } })],
    });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-job-schedule-summary').textContent).toBe('工作日 15:00');
  });

  it('覆盖不了的 cron 形态回退「自定义时间 · 原表达式」', () => {
    useCronStore.setState({
      jobs: [makeJob({ schedule: { type: 'cron', expression: '0 9 * * 1,3,5' } })],
    });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-job-schedule-summary').textContent).toBe('自定义时间 · 0 9 * * 1,3,5');
  });

  it('every 调度：每 2 小时 + 循环 chip', () => {
    useCronStore.setState({
      jobs: [makeJob({
        scheduleType: 'every',
        schedule: { type: 'every', interval: 2, unit: 'hours' },
      })],
    });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-job-schedule-summary').textContent).toBe('每 2 小时');
    expect(screen.getByTestId('cron-job-trigger-kind').textContent).toBe('循环');
  });

  it('心跳任务 chip 显示心跳（agent.context.heartbeatTask）', () => {
    useCronStore.setState({
      jobs: [makeJob({
        action: { type: 'agent', agentType: 'default', prompt: '巡检', context: { heartbeatTask: true } },
      })],
    });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-job-trigger-kind').textContent).toBe('心跳');
  });

  it('事件监听任务 chip 显示事件（agent.context.externalWatch）', () => {
    useCronStore.setState({
      jobs: [makeJob({
        action: {
          type: 'agent',
          agentType: 'default',
          prompt: '盯日历',
          context: { externalWatch: { source: 'feishu-calendar', calendarId: 'cal-1' } },
        },
      })],
    });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-job-trigger-kind').textContent).toBe('事件');
  });

  it('任务名右侧显示图标文字位置 pill，并可按全部/本地/云端分段筛选', () => {
    useCronStore.setState({
      jobs: [
        makeJob({ id: 'local-job', name: '本地任务', runsOn: 'local' }),
        makeJob({ id: 'cloud-job', name: '云端任务', runsOn: 'cloud' }),
      ],
    });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-runs-on-pill-local').textContent).toContain('本地');
    expect(screen.getByTestId('cron-runs-on-pill-cloud').textContent).toContain('云端');

    fireEvent.click(screen.getByTestId('cron-location-filter-cloud'));
    expect(screen.queryByText('本地任务')).toBeNull();
    expect(screen.getByText('云端任务')).toBeTruthy();
  });

  // FB-211：pill 不可被压缩、不可竖排折行（挨着 truncate 的任务名时）
  it('本地/云端 pill 都带 shrink-0 与 whitespace-nowrap', () => {
    useCronStore.setState({
      jobs: [
        makeJob({ id: 'local-job', name: '本地任务', runsOn: 'local' }),
        makeJob({ id: 'cloud-job', name: '云端任务', runsOn: 'cloud' }),
      ],
    });
    render(<CronJobList />);
    for (const runsOn of ['local', 'cloud'] as const) {
      const pill = screen.getByTestId(`cron-runs-on-pill-${runsOn}`);
      expect(pill.classList.contains('shrink-0')).toBe(true);
      expect(pill.classList.contains('whitespace-nowrap')).toBe(true);
    }
  });
});

describe('CronJobList 等你批准 badge（N-CRON-UNATTENDED-BASH-PARK-STUCK-VISIBLE）', () => {
  it('map 命中的 job 显示 amber badge，未命中的 job 保持原状态 chip；map 清空后 badge 消失', () => {
    useCronStore.setState({
      jobs: [makeJob({ id: 'job-1', name: '每日晨报' }), makeJob({ id: 'job-2', name: '周报盘点' })],
    });
    const { rerender } = render(<CronJobList awaitingByJobId={new Map([['job-1', { jobId: 'job-1' }]])} />);

    const badges = screen.getAllByTestId('cron-job-awaiting-approval');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe('等你批准');
    expect(badges[0].classList.contains('text-badge-warning')).toBe(true);
    expect(badges[0].closest('button')!.textContent).toContain('每日晨报');

    const otherRow = screen.getByText('周报盘点').closest('button')!;
    expect(otherRow.querySelector('[data-testid="cron-job-awaiting-approval"]')).toBeNull();

    rerender(<CronJobList awaitingByJobId={new Map()} />);
    expect(screen.queryByTestId('cron-job-awaiting-approval')).toBeNull();
  });
});

describe('CronJobList 内置维护任务本地化展示（N-FIX-BUILTIN-CRON-JOB-ENGLISH-COPY）', () => {
  const initialLanguage = useAppStore.getState().language;
  afterEach(() => {
    useAppStore.setState({ language: initialLanguage });
  });

  const builtinMemoryJob = makeJob({
    id: 'builtin-mem',
    name: '[Maintenance] Light Memory consolidation',
    description: 'Compress ~/.code-agent/memory without losing information (quick model).',
    action: { type: 'memory-consolidation', dryRun: true },
    tags: [MEMORY_CONSOLIDATION.JOB_TAG],
  });

  const userJob = makeJob({
    id: 'user-job',
    name: '每日英语单词',
    description: '每天早上背 5 个单词',
    action: { type: 'agent', agentType: 'default', prompt: '推荐 5 个单词' },
    tags: ['study'],
  });

  it('中文界面下内置记忆任务显示「记忆整理」与中文描述，不含 [Maintenance] 或路径；普通用户任务原样渲染', () => {
    useAppStore.setState({ language: 'zh' });
    useCronStore.setState({ jobs: [builtinMemoryJob, userJob] });
    const { container } = render(<CronJobList />);

    expect(screen.getByText('记忆整理')).toBeTruthy();
    expect(screen.getByText('定期整理你的记忆文件，合并重复内容，不会丢失信息。')).toBeTruthy();
    expect(container.textContent).not.toContain('[Maintenance]');
    expect(container.textContent).not.toContain('Light Memory consolidation');
    expect(container.textContent).not.toContain('~/.code-agent/memory');

    expect(screen.getByText('每日英语单词')).toBeTruthy();
    expect(screen.getByText('每天早上背 5 个单词')).toBeTruthy();
  });

  it('英文界面下内置记忆任务保持英文原名与原描述，普通用户任务原样渲染', () => {
    useAppStore.setState({ language: 'en' });
    useCronStore.setState({ jobs: [builtinMemoryJob, userJob] });
    render(<CronJobList />);

    expect(screen.getByText('[Maintenance] Light Memory consolidation')).toBeTruthy();
    expect(screen.getByText('Compress ~/.code-agent/memory without losing information (quick model).')).toBeTruthy();
    expect(screen.getByText('每日英语单词')).toBeTruthy();
  });

  it('搜索同时匹配存储原名与本地化显示名/描述', () => {
    useAppStore.setState({ language: 'zh' });
    useCronStore.setState({ jobs: [builtinMemoryJob, userJob], searchQuery: '记忆整理' });
    const { rerender } = render(<CronJobList />);
    expect(screen.getByText('记忆整理')).toBeTruthy();
    expect(screen.queryByText('每日英语单词')).toBeNull();

    act(() => {
      useCronStore.setState({ searchQuery: 'Light Memory' });
    });
    rerender(<CronJobList />);
    expect(screen.getByText('记忆整理')).toBeTruthy();
  });
});
