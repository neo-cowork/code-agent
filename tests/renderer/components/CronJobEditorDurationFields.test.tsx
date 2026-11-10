// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { cronCenterEn, cronCenterZh } from '../../../src/renderer/i18n/cronCenter';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => [],
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';

function makeJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'duration-job',
    name: 'Mailbox follow-up',
    description: '',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'hours' },
    action: { type: 'shell', command: 'echo ok' },
    runsOn: 'local',
    enabled: true,
    maxRetries: 3,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function openAdvanced(job: CronJobDefinition): void {
  render(<CronJobEditor isOpen job={job} onClose={() => undefined} />);
  fireEvent.click(screen.getByText('高级选项'));
}

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
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
    deleteJob: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('cron duration fields', () => {
  it('renders human units and sends retry/timeout as stored milliseconds', async () => {
    const updateJob = vi.fn(async (id: string, input: Partial<CronJobDefinition>) => ({ ...makeJob(), id, ...input }));
    useCronStore.setState({ updateJob });
    openAdvanced(makeJob());

    const retryInput = screen.getByTestId('cron-retry-delay-input') as HTMLInputElement;
    const retryUnit = screen.getByTestId('cron-retry-delay-unit') as HTMLSelectElement;
    const timeoutInput = screen.getByTestId('cron-timeout-input') as HTMLInputElement;
    expect(retryInput.placeholder).toBe(cronCenterZh.cronCenter.manualEditor.retryDelayPlaceholder);
    expect(withinOptions(retryUnit)).toEqual(['seconds', 'minutes']);
    expect(timeoutInput.placeholder).toBe(cronCenterZh.cronCenter.manualEditor.timeoutPlaceholder);

    fireEvent.change(retryInput, { target: { value: '2' } });
    fireEvent.change(retryUnit, { target: { value: 'minutes' } });
    fireEvent.change(timeoutInput, { target: { value: '1.5' } });
    fireEvent.click(screen.getByText('保存修改'));
    expect(updateJob).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));

    await waitFor(() => expect(updateJob).toHaveBeenCalledTimes(1));
    const payload = updateJob.mock.calls[0]?.[1];
    expect(payload).toMatchObject({ retryDelay: 120_000, timeout: 1_500 });
    expect(payload.retryDelay).not.toBeNaN();
    expect(payload.timeout).not.toBeNaN();
  });

  it('sends null for blank timeout and preserves untouched stored milliseconds', async () => {
    const blankUpdate = vi.fn(async (id: string, input: Partial<CronJobDefinition>) => ({ ...makeJob(), id, ...input }));
    useCronStore.setState({ updateJob: blankUpdate });
    openAdvanced(makeJob({ retryDelay: undefined, timeout: undefined }));
    fireEvent.click(screen.getByText('保存修改'));
    expect(blankUpdate).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));
    await waitFor(() => expect(blankUpdate).toHaveBeenCalledTimes(1));
    expect(blankUpdate.mock.calls[0]?.[1]).toMatchObject({ retryDelay: undefined, timeout: null });

    cleanup();
    const untouchedUpdate = vi.fn(async (id: string, input: Partial<CronJobDefinition>) => ({ ...makeJob(), id, ...input }));
    useCronStore.setState({ updateJob: untouchedUpdate });
    openAdvanced(makeJob({ retryDelay: 60_000, timeout: 90_000 }));
    expect((screen.getByTestId('cron-retry-delay-input') as HTMLInputElement).value).toBe('1');
    expect((screen.getByTestId('cron-retry-delay-unit') as HTMLSelectElement).value).toBe('minutes');
    expect((screen.getByTestId('cron-timeout-input') as HTMLInputElement).value).toBe('90');
    fireEvent.click(screen.getByText('保存修改'));
    expect(untouchedUpdate).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));
    await waitFor(() => expect(untouchedUpdate).toHaveBeenCalledTimes(1));
    expect(untouchedUpdate.mock.calls[0]?.[1]).toMatchObject({ retryDelay: 60_000, timeout: 90_000 });
  });

  it.each([
    ['0', 'seconds', 0],
    ['1000000000', 'minutes', 60_000_000_000_000],
  ])('accepts %s %s without writing NaN', async (displayValue, unit, expectedMilliseconds) => {
    const updateJob = vi.fn(async (id: string, input: Partial<CronJobDefinition>) => ({ ...makeJob(), id, ...input }));
    useCronStore.setState({ updateJob });
    openAdvanced(makeJob());
    fireEvent.change(screen.getByTestId('cron-retry-delay-input'), { target: { value: displayValue } });
    fireEvent.change(screen.getByTestId('cron-retry-delay-unit'), { target: { value: unit } });
    fireEvent.click(screen.getByText('保存修改'));
    expect(updateJob).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));
    await waitFor(() => expect(updateJob).toHaveBeenCalledTimes(1));
    expect(updateJob.mock.calls[0]?.[1].retryDelay).toBe(expectedMilliseconds);
  });

  it('shows a plain-language validation message and keeps the last valid value for non-numeric input', async () => {
    const updateJob = vi.fn(async (id: string, input: Partial<CronJobDefinition>) => ({ ...makeJob(), id, ...input }));
    useCronStore.setState({ updateJob });
    openAdvanced(makeJob());
    fireEvent.change(screen.getByTestId('cron-retry-delay-input'), { target: { value: 'not a duration' } });
    expect(screen.getByRole('alert').textContent).toBe(cronCenterZh.cronCenter.manualEditor.durationInvalid);
    fireEvent.click(screen.getByText('保存修改'));
    expect(updateJob).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('cron-pending-routine-confirm'));
    await waitFor(() => expect(updateJob).toHaveBeenCalledTimes(1));
    expect(updateJob.mock.calls[0]?.[1].retryDelay).toBeUndefined();
  });

  it('uses localized duration labels and units in the English advanced tab', () => {
    cleanup();
    useAppStore.setState({ language: 'en' });
    openAdvanced(makeJob());
    expect(screen.getByText(cronCenterEn.cronCenter.manualEditor.retryDelayLabel)).toBeTruthy();
    expect(screen.getByText(cronCenterEn.cronCenter.manualEditor.timeoutLabel)).toBeTruthy();
    expect(screen.getByText(cronCenterEn.cronCenter.manualEditor.retryDelayHint)).toBeTruthy();
    expect(Array.from((screen.getByTestId('cron-timeout-unit') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
      cronCenterEn.cronCenter.manualEditor.durationUnits.seconds,
      cronCenterEn.cronCenter.manualEditor.durationUnits.minutes,
      cronCenterEn.cronCenter.manualEditor.durationUnits.hours,
    ]);
    expect(screen.queryByText('重试间隔 (ms)')).toBeNull();
  });

  it('localizes the two schedule-type options in both languages from cronCenter', async () => {
    cleanup();
    useAppStore.setState({ language: 'en' });
    render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
    fireEvent.click(screen.getByText('Manual setup'));
    const options = Array.from(screen.getByTestId('cron-schedule-type-select').querySelectorAll('option')).map((option) => option.textContent);
    expect(options).toContain(cronCenterEn.cronCenter.manualEditor.oneTimeScheduleOption);
    expect(options).toContain(cronCenterEn.cronCenter.manualEditor.intervalScheduleOption);
    expect(options).not.toContain('一次性');
    expect(options).not.toContain('间隔循环');

    cleanup();
    useAppStore.setState({ language: 'zh' });
    render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
    fireEvent.click(screen.getByText('手动配置'));
    const zhOptions = Array.from(screen.getByTestId('cron-schedule-type-select').querySelectorAll('option')).map((option) => option.textContent);
    expect(zhOptions).toContain(cronCenterZh.cronCenter.manualEditor.oneTimeScheduleOption);
    expect(zhOptions).toContain(cronCenterZh.cronCenter.manualEditor.intervalScheduleOption);
  });
});

function withinOptions(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((option) => option.value);
}
