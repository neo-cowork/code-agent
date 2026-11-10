// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition, CronJobExecution } from '../../../src/shared/contract/cron';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn(), invokeDomain: vi.fn(), on: vi.fn(() => vi.fn()) },
}));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: { getExecutions: vi.fn().mockResolvedValue([]) },
}));

import { CronJobList } from '../../../src/renderer/components/features/cron/CronJobList';
import { CronJobDetail } from '../../../src/renderer/components/features/cron/CronJobDetail';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const job: CronJobDefinition = {
  id: 'meeting-summary', name: '会议笔记晨间摘要', runsOn: 'local', enabled: true,
  scheduleType: 'cron', schedule: { type: 'cron', expression: '17 8 * * *' },
  action: { type: 'agent', agentType: 'default', prompt: '每天早上保存会议摘要' },
  createdAt: 1, updatedAt: 1,
};
const loadExecutions = useCronStore.getState().loadExecutions;

beforeEach(() => {
  useCronStore.setState({
    jobs: [job], latestExecutions: {}, executionsByJobId: {}, selectedJobId: job.id,
    filterMode: 'all', searchQuery: '', isLoading: false, error: null,
    loadExecutions: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
  useCronStore.setState({ loadExecutions });
});

const cases = [
  { name: 'approved-completed', denied: false, result: { digest: { artifacts: ['summary.md'] } } },
  { name: 'denied-no-output', denied: true, result: {
    permissionDenied: { count: 1, steps: [{ tool: 'Bash', summary: 'python3 summarize-notes.py', reason: 'user' }] },
  } },
  { name: 'productive-after-denial', denied: false, result: { digest: { artifacts: ['summary-fallback.md'] } } },
];

describe.each(['zh', 'en'] as const)('latest execution verdict (%s)', (language) => {
  it.each(cases)('$name agrees on job card and job detail', ({ denied, result }) => {
    useAppStore.setState({ language });
    const execution: CronJobExecution = {
      id: 'meeting-run', jobId: job.id, status: 'completed', scheduledAt: 1,
      startedAt: 1, completedAt: 2, retryAttempt: 0, result,
    };
    useCronStore.setState({ latestExecutions: { [job.id]: execution } });
    const list = render(<CronJobList />);
    const detail = render(<CronJobDetail job={job} />);
    const verdict = denied ? (language === 'zh' ? '需处理' : 'Needs attention') : (language === 'zh' ? '完成' : 'Done');
    const label = `${language === 'zh' ? '最近: ' : 'Last: '}${verdict}`;
    for (const view of [list, detail]) {
      const badge = within(view.container).getByText(label);
      expect(badge.classList.contains(denied ? 'text-badge-warning' : 'text-badge-success')).toBe(true);
      if (denied) expect(view.container.textContent).not.toContain(language === 'zh' ? '最近: 完成' : 'Last: Done');
    }
  });
});
