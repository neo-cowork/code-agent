// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateCronJobDefinition, CronJobDefinition } from '../../../src/shared/contract/cron';
import { CRON_AGENT_TYPES } from '../../../src/shared/constants';
import { cronCenterEn, cronCenterZh } from '../../../src/renderer/i18n/cronCenter';
import type { UpdateCronJobInput } from '../../../src/renderer/services/cronClient';

vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => [],
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

function agentJob(
  agentType = 'default',
  context: Record<string, unknown> | undefined = undefined,
): CronJobDefinition {
  return {
    id: 'job-agent-fields',
    name: '每日整理',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'days' },
    action: { type: 'agent', agentType, prompt: '整理今天的工作', context },
    runsOn: 'local',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function storedJob(input: CreateCronJobDefinition): CronJobDefinition {
  return { ...input, id: 'created-agent-job', runsOn: input.runsOn ?? 'local', createdAt: 1, updatedAt: 1 };
}

function controlForLabel(label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const control = screen.getByText(label).parentElement?.querySelector('input, textarea, select');
  if (!control) throw new Error(`no control for ${label}`);
  return control as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
}

function openActionTab(job: CronJobDefinition): void {
  render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
  const copy = useAppStore.getState().language === 'en' ? cronCenterEn : cronCenterZh;
  fireEvent.click(screen.getByText(copy.cronCenter.editorChrome.tabs.action));
}

async function openNewManualAgent(): Promise<void> {
  render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
  fireEvent.click(screen.getByText('手动配置'));
  await screen.findByText('调度方式');
  fireEvent.click(screen.getByText('执行动作'));
  fireEvent.change(controlForLabel('动作类型'), { target: { value: 'agent' } });
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
    createJob: vi.fn(),
    updateJob: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('manual cron agent action fields', () => {
  it('shows and saves an agent prompt raw while the display layer masks it elsewhere', async () => {
    const rawPrompt = 'back up notes --password=hunter2xyz';
    const job = agentJob();
    job.action = { type: 'agent', agentType: 'default', prompt: rawPrompt };
    const updateJob = vi.fn(async (_id: string, input: UpdateCronJobInput) => ({ ...job, ...input }));
    useCronStore.setState({ updateJob });
    openActionTab(job);

    expect((screen.getByTestId('cron-agent-task-instructions') as HTMLTextAreaElement).value).toBe(rawPrompt);
    fireEvent.click(screen.getByText('保存修改'));
    expect(updateJob).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));

    await waitFor(() => expect(updateJob).toHaveBeenCalledTimes(1));
    expect(updateJob.mock.calls[0]?.[1]).toMatchObject({ action: { type: 'agent', prompt: rawPrompt } });
  });

  it('uses every CRON_AGENT_TYPES value with a description, defaults to default, and saves without editing type or context', async () => {
    const createJob = vi.fn(async (input: CreateCronJobDefinition) => storedJob(input));
    useCronStore.setState({ createJob });
    await openNewManualAgent();

    const select = screen.getByTestId('cron-agent-type-select') as HTMLSelectElement;
    const options = within(select).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((option) => option.value)).toEqual([...CRON_AGENT_TYPES]);
    for (const value of CRON_AGENT_TYPES) {
      const copy = cronCenterZh.cronCenter.manualEditor.agentTypes[value];
      expect(options.find((option) => option.value === value)?.textContent).toBe(`${copy.name} — ${copy.description}`);
    }
    expect(select.value).toBe('default');

    fireEvent.click(screen.getByText('基本设置'));
    fireEvent.change(controlForLabel('任务名称'), { target: { value: '每日整理' } });
    fireEvent.click(screen.getByText('执行动作'));
    fireEvent.change(screen.getByTestId('cron-agent-task-instructions'), { target: { value: '整理今天的工作' } });
    fireEvent.click(screen.getByText('创建任务'));
    expect(createJob).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));

    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
    expect(createJob.mock.calls[0]?.[0]).toMatchObject({
      action: { type: 'agent', agentType: 'default', prompt: '整理今天的工作', context: {} },
    });
  });

  it('keeps an unknown stored agent type selected as one extra described option', () => {
    openActionTab(agentJob('legacy-agent'));
    const select = screen.getByTestId('cron-agent-type-select') as HTMLSelectElement;
    const options = within(select).getAllByRole('option') as HTMLOptionElement[];

    expect(options.map((option) => option.value)).toEqual([...CRON_AGENT_TYPES, 'legacy-agent']);
    expect(options.at(-1)?.textContent).toContain(cronCenterZh.cronCenter.manualEditor.unknownAgentTypeDescription);
    expect(select.value).toBe('legacy-agent');
  });

  it('shows the task-instructions label from cronCenter in zh and en, with no Prompt label', () => {
    openActionTab(agentJob());
    expect(screen.getByText('任务指令')).toBeTruthy();
    expect(screen.queryByText('Prompt')).toBeNull();
    expect(cronCenterZh.cronCenter.manualEditor.taskInstructionsLabel).toBe('任务指令');

    cleanup();
    useAppStore.setState({ language: 'en' });
    openActionTab(agentJob());
    expect(screen.getByText('Task instructions')).toBeTruthy();
    expect(screen.queryByText('Prompt')).toBeNull();
    expect(cronCenterEn.cronCenter.manualEditor.taskInstructionsLabel).toBe('Task instructions');
  });

  it('collapses empty context for a new task and expands stored non-empty context with a hint and example', async () => {
    await openNewManualAgent();
    expect((screen.getByTestId('cron-agent-context-disclosure') as HTMLDetailsElement).open).toBe(false);

    cleanup();
    openActionTab(agentJob('default', { channel: 'ops' }));
    expect((screen.getByTestId('cron-agent-context-disclosure') as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByText(cronCenterZh.cronCenter.manualEditor.extraParametersHint)).toBeTruthy();
    expect(screen.getByText(cronCenterZh.cronCenter.manualEditor.extraParametersExample)).toBeTruthy();
    expect((screen.getByTestId('cron-agent-context-input') as HTMLTextAreaElement).value).toContain('"channel": "ops"');
  });

  it.each(['', '{}'])('saves %j extra parameters as an empty object without error', async (contextText) => {
    const updateJob = vi.fn(async (_id: string, input: UpdateCronJobInput) => ({ ...agentJob(), ...input }));
    useCronStore.setState({ updateJob });
    openActionTab(agentJob('default', { previous: true }));

    fireEvent.change(screen.getByTestId('cron-agent-context-input'), { target: { value: contextText } });
    fireEvent.click(screen.getByText('保存修改'));
    expect(updateJob).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));

    await waitFor(() => expect(updateJob).toHaveBeenCalledTimes(1));
    expect(updateJob.mock.calls[0]?.[1]).toMatchObject({ action: { type: 'agent', context: {} } });
  });

  it('uses plain-language cron and webhook schedule options in zh and en', async () => {
    await openNewManualAgent();
    fireEvent.click(screen.getByText('基本设置'));
    let optionText = within(screen.getByTestId('cron-schedule-type-select')).getAllByRole('option').map((option) => option.textContent);
    expect(optionText).toContain('按固定时间重复（Cron 表达式）');
    expect(optionText).toContain('外部系统通知触发（Webhook 投递）');

    cleanup();
    useAppStore.setState({ language: 'en' });
    render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
    fireEvent.click(screen.getByText('Manual setup'));
    optionText = within(await screen.findByTestId('cron-schedule-type-select')).getAllByRole('option').map((option) => option.textContent);
    expect(optionText).toContain('Repeat at fixed times (Cron expression)');
    expect(optionText).toContain('Triggered by an external system (Webhook delivery)');
  });
});
