// @vitest-environment jsdom
// N-FIX-CRON-EDIT-DIALOG-CREATE-COPY：编辑自动化的标题与启用状态文案按模式和语言呈现。
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { cronCenterEn, cronCenterZh } from '../../../src/renderer/i18n/cronCenter';

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

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

function makeJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-automation-copy',
    name: 'Summarize unread mail',
    scheduleType: 'event-mail',
    schedule: {
      type: 'event',
      source: 'connector',
      connector: 'mail',
      accountId: 'mail-account',
      mailbox: 'INBOX',
      eventName: 'message',
    },
    action: { type: 'agent', agentType: 'default', prompt: 'Summarize unread mail' },
    runsOn: 'local',
    maxRunBudget: 0.5,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function openEditor(job: CronJobDefinition | null, language: 'zh' | 'en', copySource?: CronJobDefinition): void {
  useAppStore.setState({ language });
  render(<CronJobEditor isOpen job={job} copySource={copySource} onClose={() => undefined} />);
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

describe('automation editor title and enabled copy', () => {
  it('uses automation wording for the list tab in both languages', () => {
    expect(cronCenterZh.cronCenter.tabJobs).toBe('自动化任务');
    expect(cronCenterEn.cronCenter.tabJobs).toBe('Automation tasks');
  });

  it.each([
    ['zh', cronCenterZh.cronCenter.editTitle, cronCenterZh.cronCenter.enabledStatus],
    ['en', cronCenterEn.cronCenter.editTitle, cronCenterEn.cronCenter.enabledStatus],
  ] as const)('uses edit copy for an event-mail automation in %s', (language, title, enabledCopy) => {
    openEditor(makeJob(), language);

    const heading = screen.getByRole('heading', { name: title });
    expect(heading).toBeTruthy();
    expect(heading.textContent).not.toMatch(/定时|scheduled/i);
    expect(screen.getByText(enabledCopy)).toBeTruthy();
    expect(screen.queryByText(/创建后|after creating/i)).toBeNull();
  });

  it.each([
    ['zh', cronCenterZh.cronCenter.editTitle, cronCenterZh.cronCenter.enabledStatus],
    ['en', cronCenterEn.cronCenter.editTitle, cronCenterEn.cronCenter.enabledStatus],
  ] as const)('uses the same plain edit copy for a cron automation in %s', (language, title, enabledCopy) => {
    openEditor(makeJob({
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: '0 9 * * 1-5' },
    }), language);

    const heading = screen.getByRole('heading', { name: title });
    expect(heading).toBeTruthy();
    expect(heading.textContent).not.toMatch(/定时|scheduled/i);
    expect(screen.getByText(enabledCopy)).toBeTruthy();
    expect(screen.queryByText(/创建后|after creating/i)).toBeNull();
  });

  it.each([
    ['zh', cronCenterZh.cronCenter.manualTitle, cronCenterZh.cronCenter.enableAfterCreate],
    ['en', cronCenterEn.cronCenter.manualTitle, cronCenterEn.cronCenter.enableAfterCreate],
  ] as const)('keeps creation copy for a new manual automation in %s', (language, title, enabledCopy) => {
    openEditor(null, language);
    fireEvent.click(screen.getByText(language === 'zh' ? '手动配置' : 'Manual setup'));

    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByText(enabledCopy)).toBeTruthy();
  });

  it('keeps copy mode as creation copy because it creates a new automation', () => {
    openEditor(null, 'zh', makeJob());

    expect(screen.getByRole('heading', { name: cronCenterZh.cronCenter.copyTitle })).toBeTruthy();
    expect(screen.getByText(cronCenterZh.cronCenter.enableAfterCreate)).toBeTruthy();
    expect(screen.queryByText(cronCenterZh.cronCenter.enabledStatus)).toBeNull();
  });
});
