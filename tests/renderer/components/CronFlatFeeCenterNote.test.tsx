// @vitest-environment jsdom
// N-FIX-CRON-ZERO-PRICE-BUDGET-SUMMARY-NO-HINT：包月模型 + 设了美元预算 → 自动化中心三处出现同一句话（不含模型 id）。
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition, CronJobExecution } from '../../../src/shared/contract/cron';

const invokeDomain = vi.hoisted(() => vi.fn());
const jobsHolder = vi.hoisted(() => ({ jobs: [] as unknown[] }));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain, on: vi.fn(() => () => undefined), invoke: vi.fn(async () => undefined) },
}));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    getGroupListenCheck: vi.fn().mockResolvedValue({ status: 'idle' }),
    listJobs: vi.fn(async () => jobsHolder.jobs),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: {
    countPendingReview: () => Promise.resolve(0),
    listAwaitingApprovalRuns: () => Promise.resolve([]),
  },
}));
vi.mock('../../../src/renderer/components/features/cron/AutomationReviewInbox', () => ({ AutomationReviewInbox: () => null }));
vi.mock('../../../src/renderer/components/features/cron/CronFeaturedTemplates', () => ({ CronFeaturedTemplates: () => null }));
vi.mock('../../../src/renderer/components/features/cron/CronJobList', () => ({ CronJobList: () => null }));
vi.mock('../../../src/renderer/components/features/cron/CronJobDetail', () => ({ CronJobDetail: () => null }));
vi.mock('../../../src/renderer/components/features/cron/CronJobEditor', () => ({ CronJobEditor: () => null }));
vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({ WebModeBanner: () => null }));

import { CronCenterPanel } from '../../../src/renderer/components/features/cron/CronCenterPanel';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { ModelConfig } from '../../../src/shared/contract/model';

const MODEL = 'mimo-v2.6-flash';
const COPY = {
  zh: '当前模型按月计费，不按美元计费，美元上限不会触发',
  en: 'The current model is billed monthly, not in USD, so a USD cap will not trigger',
} as const;

function setModel(provider: string, model: string, language: 'zh' | 'en') {
  const base = useAppStore.getState().modelConfig;
  useAppStore.setState({ language, modelConfig: { ...base, provider, model } as ModelConfig });
}

function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
  return {
    id: 'job-1', runsOn: 'local', name: 'Morning news', scheduleType: 'cron',
    schedule: { type: 'cron', expression: '30 8 * * *' },
    action: { type: 'agent', agentType: 'general', prompt: 'Summarize three news pages' },
    enabled: true, maxRetries: 3, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

const execution: CronJobExecution = {
  id: 'exec-1', jobId: 'job-1', status: 'completed', scheduledAt: 1, startedAt: 1, completedAt: 2, duration: 1, retryAttempt: 0,
} as CronJobExecution;

beforeEach(() => {
  invokeDomain.mockReset();
  invokeDomain.mockResolvedValue({ scopes: { unattended: { currentCost: 0, maxBudget: 0, usagePercentage: 0 } } });
  jobsHolder.jobs = [];
  useCronStore.setState({ jobs: [], allJobs: [], recentExecutions: [], latestExecutions: {}, executionsByJobId: {} });
});
afterEach(cleanup);

describe('summary row (CronCenterPanel)', () => {
  it.each(['zh', 'en'] as const)('flat-fee model + job with maxRunBudget 0.5 (%s): sentence under the summary, no model id', async (language) => {
    setModel('xiaomi', MODEL, language);
    jobsHolder.jobs = [makeJob({ maxRunBudget: 0.5 })];
    render(<CronCenterPanel onClose={() => undefined} />);
    const note = await screen.findByTestId('flat-fee-budget-note-center');
    expect(screen.getByTestId('automation-budget-summary').contains(note)).toBe(true);
    expect(note.textContent).toContain(COPY[language]);
    expect(note.textContent).not.toContain(MODEL);
    expect(note.textContent).not.toContain('maxRunBudget');
  });

  it('flat-fee model + global cap > 0 and no job cap: sentence shown', async () => {
    setModel('xiaomi', MODEL, 'zh');
    invokeDomain.mockResolvedValue({ scopes: { unattended: { currentCost: 0, maxBudget: 3, usagePercentage: 0 } } });
    render(<CronCenterPanel onClose={() => undefined} />);
    expect(await screen.findByTestId('flat-fee-budget-note-center')).toBeTruthy();
  });

  it('flat-fee model but no USD cap anywhere: nothing shown', async () => {
    setModel('xiaomi', MODEL, 'zh');
    jobsHolder.jobs = [makeJob({})];
    render(<CronCenterPanel onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('automation-budget-usage').textContent).toContain('$0.00'));
    expect(screen.queryByTestId('flat-fee-budget-note-center')).toBeNull();
  });

  it('pay-per-use model with a job cap: nothing extra', async () => {
    setModel('zhipu', 'glm-5.3', 'zh');
    jobsHolder.jobs = [makeJob({ maxRunBudget: 0.5 })];
    render(<CronCenterPanel onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('automation-budget-usage').textContent).toContain('$0.00'));
    await waitFor(() => expect(useCronStore.getState().allJobs).toHaveLength(1));
    expect(screen.queryByTestId('flat-fee-budget-note-center')).toBeNull();
  });
});

describe('run record (CronExecutionDetail)', () => {
  it.each(['zh', 'en'] as const)('hasRunBudget on flat-fee model (%s): sentence, no model id', (language) => {
    setModel('xiaomi', MODEL, language);
    render(<CronExecutionDetail execution={execution} jobName="Morning news" hasRunBudget />);
    const note = screen.getByTestId('flat-fee-budget-note-center');
    expect(note.textContent).toContain(COPY[language]);
    expect(note.textContent).not.toContain(MODEL);
  });

  it('no job budget: nothing; pay-per-use model: nothing', () => {
    setModel('xiaomi', MODEL, 'zh');
    render(<CronExecutionDetail execution={execution} jobName="Morning news" />);
    expect(screen.queryByTestId('flat-fee-budget-note-center')).toBeNull();
    cleanup();
    setModel('zhipu', 'glm-5.3', 'zh');
    render(<CronExecutionDetail execution={execution} jobName="Morning news" hasRunBudget />);
    expect(screen.queryByTestId('flat-fee-budget-note-center')).toBeNull();
  });
});
