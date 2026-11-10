// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({ useMcpServerStates: () => [] }));
vi.mock('../../../src/renderer/services/rolesClient', () => ({
  listRoles: vi.fn().mockResolvedValue([{ roleId: 'reporter', displayName: '简报助手' }]),
}));
vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjects: vi.fn().mockResolvedValue([{ id: 'reports', name: '周报归档' }]),
}));
vi.mock('../../../src/renderer/components/features/cron/useChannelCatalog', () => ({
  useChannelCatalog: () => ({
    accounts: [{ id: 'work', name: '工作飞书', type: 'feishu' }], accountsLoading: false,
    conversationsByAccount: { work: { loading: false, supported: true, conversations: [{ id: 'team', name: '团队群' }] } },
  }),
  useEventScheduleNames: () => () => ({}),
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import type { CreateCronJobInput } from '../../../src/renderer/services/cronClient';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const goal = "Reply only 'received'";
const taskName = '周一简报 carry-over';
const createJob = vi.fn(async (input: CreateCronJobInput): Promise<CronJobDefinition> => ({
  ...input, runsOn: input.runsOn ?? 'local', id: 'carry-over', createdAt: 1, updatedAt: 1,
}));

function field(label: string): HTMLInputElement | HTMLSelectElement {
  const element = screen.getByText(label).parentElement?.querySelector('input,select');
  if (!element) throw new Error(`Missing field: ${label}`);
  return element as HTMLInputElement | HTMLSelectElement;
}
function change(element: HTMLElement, value: string) {
  fireEvent.change(element, { target: { value } });
}
function switchManual() { fireEvent.click(screen.getByText('手动配置')); }

async function filledSimple() {
  render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
  await screen.findByText('简报助手');
  change(screen.getByPlaceholderText(/竞品动态/), goal);
  change(field('名称（可选）'), taskName);
  change(screen.getByTestId('cron-simple-urgency-criteria'), '客户要求当天回复');
  change(field('以谁的身份跑（可选）'), 'reporter');
  change(field('产出归档到（可选）'), 'reports');
  change(screen.getByLabelText('结果推送到（可选）'), 'work');
  change(screen.getByLabelText('选择接收会话'), 'team');
  fireEvent.click(screen.getByTestId('cron-runs-on-cloud'));
  fireEvent.click(screen.getByTestId('cron-runs-on-local'));
  change(field('何时执行'), 'weekly');
  change(screen.getByTestId('cron-simple-time-hour'), '08');
  change(screen.getByTestId('cron-simple-time-minute'), '30');
  change(field('星期几'), '1');
  change(screen.getByTestId('cron-budget-limit-input'), '0.02');
  switchManual();
}

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
  createJob.mockClear();
  useCronStore.setState({ createJob, updateJob: vi.fn() });
});
afterEach(cleanup);

describe('simple -> manual via the real CronJobEditor link', () => {
  it('① preserves typed task name and agent prompt', async () => {
    await filledSimple();
    expect(screen.getByPlaceholderText('例如：每日数据备份')).toHaveProperty('value', taskName);
    fireEvent.click(screen.getByText('执行动作'));
    expect(screen.getByTestId('cron-agent-task-instructions')).toHaveProperty('value', goal);
  });

  it.each([
    ['schedule', (input: CreateCronJobInput) => expect(input.schedule).toMatchObject({ type: 'cron', expression: '30 8 * * 1' })],
    ['run location', (input: CreateCronJobInput) => expect(input.runsOn).toBe('local')],
    ['role', (input: CreateCronJobInput) => expect(input.action).toMatchObject({ roleId: 'reporter' })],
    ['archive project', (input: CreateCronJobInput) => expect(input.action).toMatchObject({ libraryProjectId: 'reports' })],
    ['result channel', (input: CreateCronJobInput) => expect(input.resultChannel).toBe('工作飞书:team')],
    ['urgency criteria', (input: CreateCronJobInput) => expect(input.action).toMatchObject({ urgencyCriteria: '客户要求当天回复' })],
    ['budget', (input: CreateCronJobInput) => expect(input.maxRunBudget).toBe(0.02)],
  ] as const)('② carries %s into the manual form and its save payload', async (_label, check) => {
    await filledSimple();
    fireEvent.click(screen.getByText('创建任务'));
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
    check(createJob.mock.calls[0][0]);
  });

  it('carries a nondefault cloud run location', async () => {
    render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
    await screen.findByText('简报助手');
    fireEvent.click(screen.getByTestId('cron-runs-on-cloud'));
    switchManual();
    expect(screen.getByTestId('cron-runs-on-cloud').className).toContain('border-badge-info/50');
  });

  it('③ blank name stays blank with placeholder instead of goal-derived fallback', async () => {
    render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
    await screen.findByText('简报助手');
    change(screen.getByPlaceholderText(/竞品动态/), goal);
    switchManual();
    expect(screen.getByPlaceholderText('例如：每日数据备份')).toHaveProperty('value', '');
  });

  it('blank goal switches without validation errors and keeps an empty prompt', async () => {
    render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
    await screen.findByText('简报助手');
    switchManual();
    expect(screen.queryByText('请填写目标')).toBeNull();
    fireEvent.click(screen.getByText('执行动作'));
    expect(screen.getByTestId('cron-agent-task-instructions')).toHaveProperty('value', '');
  });

  it('④ simple creation budget 0.02 survives buildSimpleDraft -> buildCronJobInput -> buildDraftFromJob into Edit advanced', async () => {
    const view = render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
    change(screen.getByPlaceholderText(/竞品动态/), goal);
    change(screen.getByTestId('cron-budget-limit-input'), '0.02');
    fireEvent.click(screen.getByText('创建自动化'));
    const confirmSave = await screen.findByTestId('cron-pending-routine-confirm');
    expect(createJob).not.toHaveBeenCalled();
    fireEvent.click(confirmSave);
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
    const job = await createJob.mock.results[0].value;
    expect(job.maxRunBudget).toBe(0.02);
    expect(job.maxRuns).toBeNull(); // Simple form has no max-runs input; retain unlimited.
    view.unmount();
    render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
    fireEvent.click(screen.getByText('高级选项'));
    expect(screen.getByDisplayValue('0.02')).toBeTruthy();
    expect(field('运行次数上限')).toHaveProperty('value', '');
  });
});
