// @vitest-environment jsdom
import React from 'react';
import { flushSync } from 'react-dom';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { CronCenterPanel } from '../../../src/renderer/components/features/cron/CronCenterPanel';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { cronClient } from '../../../src/renderer/services/cronClient';

vi.mock('../../../src/renderer/services/cronClient', () => ({ cronClient: {
  listJobs: vi.fn(), getStats: vi.fn().mockResolvedValue(null),
  getExecutions: vi.fn().mockResolvedValue([]),
} }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: {
  invokeDomain: vi.fn().mockResolvedValue(undefined),
  invoke: vi.fn().mockResolvedValue([]), on: vi.fn(() => () => undefined),
} }));
vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({ sessionAutomationClient: {
  listParkedApprovals: vi.fn().mockResolvedValue([]),
  listPendingReview: vi.fn().mockResolvedValue([]),
  countPendingReview: vi.fn().mockResolvedValue(0), listAwaitingApprovalRuns: vi.fn().mockResolvedValue([]),
} }));

const job: CronJobDefinition = {
  id: 'weekly-report', name: 'Weekly report', enabled: true, runsOn: 'local',
  scheduleType: 'cron', schedule: { type: 'cron', expression: '0 9 * * 1' },
  action: { type: 'agent', agentType: 'default', prompt: 'Summarize weekly progress' },
  createdAt: 1, updatedAt: 1,
};
beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
  useCronStore.setState({ jobs: [], allJobs: [], selectedJobId: null, isEditorOpen: false,
    editingJobId: null, copyingJobId: null, filterMode: 'all', searchQuery: '',
    isLoading: false, error: null, latestExecutions: {}, executionsByJobId: {}, recentExecutions: [] });
  vi.mocked(cronClient.listJobs).mockResolvedValue([job]);
});
afterEach(cleanup);

function escapeWithBrowserCheckpoint(input: HTMLElement): void {
  // Browsers run a microtask checkpoint between native document/window callbacks.
  // jsdom's dispatchEvent does not; flush the real store's pending React update
  // after Modal's document handler to reproduce that browser scheduling boundary.
  const flushDiscreteUpdates = () => flushSync(() => undefined);
  document.addEventListener('keydown', flushDiscreteUpdates);
  try {
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  } finally {
    document.removeEventListener('keydown', flushDiscreteUpdates);
  }
}

it('Escape in create name closes only editor and retains center list and detail', async () => {
  const onClose = vi.fn();
  render(<CronCenterPanel onClose={onClose} />);
  await waitFor(() => expect(useCronStore.getState().isLoading).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '新建', exact: true }));
  const input = within(screen.getByRole('dialog')).getByPlaceholderText('不填就用目标开头');
  input.focus();
  fireEvent.change(input, { target: { value: 'Weekly summary' } });
  escapeWithBrowserCheckpoint(input);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(onClose).not.toHaveBeenCalled();
  expect(useCronStore.getState().isEditorOpen).toBe(false);
  expect(screen.getByTestId('cron-center-scroll')).toBeTruthy();
  expect(screen.getAllByText('Weekly report').length).toBeGreaterThanOrEqual(2);
});

it('Escape in existing job editor closes only editor and retains center list and detail', async () => {
  const onClose = vi.fn();
  render(<CronCenterPanel onClose={onClose} />);
  const edit = await screen.findByRole('button', { name: '编辑', exact: true });
  fireEvent.click(edit);
  const input = within(screen.getByRole('dialog')).getByDisplayValue('Weekly report');
  input.focus();
  escapeWithBrowserCheckpoint(input);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(useCronStore.getState().isEditorOpen).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByTestId('cron-center-scroll')).toBeTruthy();
  expect(screen.getAllByText('Weekly report').length).toBeGreaterThanOrEqual(2);
});

it('second Escape after editor closes calls center onClose exactly once', async () => {
  const onClose = vi.fn();
  render(<CronCenterPanel onClose={onClose} />);
  await waitFor(() => expect(useCronStore.getState().isLoading).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '新建', exact: true }));
  const input = within(screen.getByRole('dialog')).getByPlaceholderText('不填就用目标开头');
  input.focus();
  escapeWithBrowserCheckpoint(input);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});
