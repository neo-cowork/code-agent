// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract';
import { BUTTON_DANGER_CLASS } from '../../../src/renderer/components/primitives/Button';
import { ConfirmPromptHost } from '../../../src/renderer/components/ConfirmPromptHost';
import { CronJobDetail } from '../../../src/renderer/components/features/cron/CronJobDetail';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

const job: CronJobDefinition = {
  id: 'job-water',
  name: 'Water reminder',
  enabled: true,
  runsOn: 'local',
  scheduleType: 'cron',
  schedule: { type: 'cron', expression: '0 9 * * *' },
  action: { type: 'agent', agentType: 'default', prompt: 'Remind me to drink water' },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const deleteJob = vi.fn(async () => true);

describe.each([
  { language: 'zh', title: '删除定时任务', cancel: '取消', remove: '删除' },
  { language: 'en', title: 'Delete scheduled task', cancel: 'Cancel', remove: 'Delete' },
] as const)('scheduled task deletion in $language', ({ language, title, cancel, remove }) => {
  const previousAppState = useAppStore.getInitialState();
  const previousCronState = useCronStore.getInitialState();

  beforeEach(() => {
    deleteJob.mockClear();
    useAppStore.setState({ language });
    useCronStore.setState({ deleteJob, loadExecutions: vi.fn(async () => {}) });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState(previousAppState);
    useCronStore.setState(previousCronState);
    vi.restoreAllMocks();
  });

  it.each(['cancel', 'escape', 'delete'])('%s settles the dialog through the App host', async (action) => {
    const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container } = render(<><CronJobDetail job={job} /><ConfirmPromptHost /></>);
    fireEvent.click(within(screen.getByTestId('cron-job-detail')).getByRole('button', { name: remove }));

    expect(nativeConfirm).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: title });
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.textContent).toContain(job.name);
    const cancelButton = within(dialog).getByRole('button', { name: cancel });
    const deleteButton = within(dialog).getByRole('button', { name: remove });
    expect(deleteButton.className).toContain(BUTTON_DANGER_CLASS);
    expect(document.activeElement).not.toBe(deleteButton);
    expect(deleteJob).not.toHaveBeenCalled();

    if (action === 'escape') fireEvent.keyDown(dialog, { key: 'Escape' });
    else fireEvent.click(action === 'cancel' ? cancelButton : deleteButton);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).toBeNull());
    if (action === 'delete') expect(deleteJob).toHaveBeenCalledExactlyOnceWith(job.id);
    else expect(deleteJob).not.toHaveBeenCalled();
  });
});
