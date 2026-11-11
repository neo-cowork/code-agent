// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { cronCenterEn } from '../../../src/renderer/i18n/cronCenter';

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

import CronJobEditor from '../../../src/renderer/components/features/cron/CronJobEditor';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

type LocalScheduleKind = 'at' | 'every' | 'cron';
type LocalActionKind = 'shell' | 'agent';

const CJK = /[一-鿿]/;
const inspectedAttributes = ['placeholder', 'title', 'aria-label', 'hint'] as const;

function scheduleFields(scheduleType: LocalScheduleKind): Pick<CronJobDefinition, 'scheduleType' | 'schedule'> {
  if (scheduleType === 'at') {
    return { scheduleType, schedule: { type: 'at', datetime: '2026-11-16T09:00:00.000Z' } };
  }
  if (scheduleType === 'every') {
    return { scheduleType, schedule: { type: 'every', interval: 1, unit: 'hours' } };
  }
  return { scheduleType, schedule: { type: 'cron', expression: '0 9 * * 1', timezone: 'Asia/Shanghai' } };
}

function makeJob(scheduleType: LocalScheduleKind, actionType: LocalActionKind): CronJobDefinition {
  return {
    id: `job-editor-chrome-${scheduleType}-${actionType}`,
    name: 'Weekly report',
    description: 'Prepare the weekly report',
    ...scheduleFields(scheduleType),
    action: actionType === 'shell'
      ? { type: 'shell', command: 'generate-weekly-report', usePty: true }
      : { type: 'agent', agentType: 'default', prompt: 'Prepare the weekly report' },
    runsOn: 'local',
    maxRunBudget: 2,
    maxRuns: 12,
    runCount: 3,
    maxRetries: 2,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function openEditor(job: CronJobDefinition, language: 'zh' | 'en'): void {
  useAppStore.setState({ language });
  render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
}

function expectNoCjk(): void {
  expect(document.body.textContent).not.toMatch(CJK);
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of inspectedAttributes) {
      const value = element.getAttribute(attribute);
      if (value !== null) expect(value, `${attribute} on ${element.tagName}`).not.toMatch(CJK);
    }
  }
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
    createJob: vi.fn(),
    updateJob: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
  vi.clearAllMocks();
});

describe('cron editor chrome localization', () => {
  it.each([
    ['at', 'shell'],
    ['at', 'agent'],
    ['every', 'shell'],
    ['every', 'agent'],
    ['cron', 'shell'],
    ['cron', 'agent'],
  ] as const)('en %s schedule with %s action: basic/action/advanced contain no CJK', (scheduleType, actionType) => {
    openEditor(makeJob(scheduleType, actionType), 'en');
    const { tabs } = cronCenterEn.cronCenter.editorChrome;

    expect(screen.getByRole('heading', { name: cronCenterEn.cronCenter.editTitle })).toBeTruthy();
    expectNoCjk();
    fireEvent.click(screen.getByText(tabs.action));
    expectNoCjk();
    fireEvent.click(screen.getByText(tabs.advanced));
    expectNoCjk();
    fireEvent.click(screen.getByText(tabs.basic));
    expectNoCjk();
  });

  it.each(['at', 'every', 'cron'] as const)('keeps the original zh labels for %s schedules across all tabs', (scheduleType) => {
    openEditor(makeJob(scheduleType, 'shell'), 'zh');

    for (const label of ['基本设置', '执行动作', '高级选项', '任务名称', '描述', '标签', '状态', '调度方式', '调度类型', '取消', '保存修改']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByPlaceholderText('例如：每日数据备份')).toBeTruthy();
    expect(screen.getByPlaceholderText('简要说明任务用途')).toBeTruthy();
    if (scheduleType === 'at') expect(screen.getByText('执行时间')).toBeTruthy();
    if (scheduleType === 'every') {
      for (const label of ['间隔值', '单位', '分钟', '小时', '天', '开始时间', '结束时间']) {
        expect(screen.getByText(label)).toBeTruthy();
      }
      expect(screen.getByText('小时级任务会按任务 ID 自动错峰到非整点分钟，避免扎堆触发。')).toBeTruthy();
      expect(screen.getAllByPlaceholderText('可选')).toHaveLength(2);
    }
    if (scheduleType === 'cron') {
      expect(screen.getByText('Cron 表达式')).toBeTruthy();
      expect(screen.getByText('时区')).toBeTruthy();
      expect(screen.getByText(/整点任务容易和其他任务扎堆触发/)).toBeTruthy();
    }

    fireEvent.click(screen.getByText('执行动作'));
    for (const label of ['动作类型', '命令', '工作目录', '终端模式', '使用 PTY（交互式命令）']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByPlaceholderText('默认为项目根目录')).toBeTruthy();

    fireEvent.click(screen.getByText('高级选项'));
    for (const label of [
      '配置重试策略和执行超时，通常保持默认即可。',
      '最大重试次数',
      '单次预算上限 (USD)',
      '本次运行花费超过该金额即停车并自动停用，留空为不限。',
      '运行次数上限',
      '已运行 3/12 次，到数自动停用；重新启用后计数清零。留空为不限。',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByPlaceholderText('不限').length).toBeGreaterThanOrEqual(2);
  });
});
