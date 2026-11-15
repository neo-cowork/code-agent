// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition, CronJobExecution } from '../../../src/shared/contract';
import { CronJobDetail } from '../../../src/renderer/components/features/cron/CronJobDetail';
import { CronJobList } from '../../../src/renderer/components/features/cron/CronJobList';
import { CronExecutionList } from '../../../src/renderer/components/features/cron/CronExecutionList';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';
import { MemoryEntryHistoryList } from '../../../src/renderer/components/features/settings/tabs/MemoryEntryHistoryList';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

vi.mock('../../../src/renderer/services/cronClient', () => ({ cronClient: {
  getExecutions: vi.fn().mockResolvedValue([]),
  listJobs: vi.fn().mockResolvedValue([]), getStats: vi.fn().mockResolvedValue(null),
} }));

const at = new Date(2026, 10, 9, 4, 0, 45).getTime();
const job: CronJobDefinition = {
  id: 'notes', name: 'Morning notes summary', runsOn: 'local', enabled: true,
  scheduleType: 'cron', schedule: { type: 'cron', expression: '0 4 * * *' },
  action: { type: 'agent', agentType: 'default', prompt: 'Summarize notes.txt into summary.md' },
  createdAt: at, updatedAt: at, nextRunAt: at,
};
afterEach(() => { cleanup(); vi.useRealTimers(); useAppStore.setState({ language: 'zh' }); });

describe.each(['zh', 'en'] as const)('date-time screens in %s', (language) => {
  it('detail and job list next-run text use the shared full format', () => {
    useAppStore.setState({ language });
    useCronStore.setState({ jobs: [job], latestExecutions: {}, executionsByJobId: {}, filterMode: 'all', searchQuery: '', isLoading: false });
    render(<><CronJobDetail job={job} /><CronJobList /></>);
    expect(screen.getByTestId('cron-detail-next-run').textContent).toContain('2026/11/09 04:00');
    expect(screen.getByTestId('cron-job-next-run').textContent).toContain('2026/11/09 04:00');
  });

  it('memory change history row uses the shared minute precision', () => {
    render(<MemoryEntryHistoryList rows={[{
      id: 1, timestamp: new Date(2026, 10, 4, 0, 35, 28).getTime(), operation: 'update',
      memoryId: 'preferences', entryId: 'short-answers', actor: 'user_manual',
      beforeContent: 'I prefer short answers.', afterContent: 'I prefer short answers in three bullets.', sessionId: null,
    }]} failed={false} labels={(language === 'en' ? en : zh).settings.memory}
    locale={language === 'en' ? 'en-US' : 'zh-CN'} busy={false} restoreFailedRowIds={new Set()} onRestore={async () => true} />);
    expect(screen.getByTestId('memory-entry-history-row').textContent).toContain('2026/11/04 00:35');
    expect(screen.getByTestId('memory-entry-history-row').textContent).not.toMatch(/AM|PM|00:35:28/);
  });

  it('run table and detail agree with a frozen clock for current and older years', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 9));
    useAppStore.setState({ language });
    const current: CronJobExecution = { id: 'current', jobId: job.id, scheduledAt: new Date(2026, 10, 4, 0, 50, 20).getTime(), status: 'completed', retryAttempt: 0 };
    const older = { ...current, id: 'older', scheduledAt: new Date(2025, 10, 4, 0, 50, 20).getTime() };
    render(<>
      <CronExecutionList executions={[current, older]} selectedExecutionId={current.id} onSelectExecution={() => undefined} jobNameById={{ [job.id]: job.name }} />
      <CronExecutionDetail execution={current} jobName={job.name} />
      <CronExecutionDetail execution={older} jobName={job.name} />
    </>);
    const table = screen.getByTestId('cron-execution-table-scroll');
    expect(table.textContent).toContain('11/04 00:50');
    expect(table.textContent).toContain('2025/11/04 00:50');
    expect(screen.getByText('2026/11/04 00:50')).toBeTruthy();
    expect(screen.getAllByText('2025/11/04 00:50')).toHaveLength(2);
  });
});
