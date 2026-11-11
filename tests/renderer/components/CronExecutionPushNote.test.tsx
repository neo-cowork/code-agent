// @vitest-environment jsdom
// N-FIX-CRON-RESULT-PUSH-SILENT-SKIP：运行详情的「结果推送」中性卡片——不进红色 error 区。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain: vi.fn() } }));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: { listJobs: vi.fn(), getStats: vi.fn(), getExecutions: vi.fn(), getRecentExecutions: vi.fn(), triggerJob: vi.fn() },
}));
const language = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { cronCenterZh, cronCenterEn } = await import('../../../src/renderer/i18n/cronCenter');
  return {
    useI18n: () => ({ language: language.value, t: language.value === 'zh' ? cronCenterZh : cronCenterEn }),
  };
});

import type { CronJobExecution } from '@shared/contract';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';

const execution = (o: Partial<CronJobExecution> = {}): CronJobExecution => ({
  id: 'exec-1', jobId: 'job-1', runsOn: 'local', status: 'completed', scheduledAt: 1, retryAttempt: 0, ...o,
});

afterEach(() => { cleanup(); language.value = 'zh'; });

describe('CronExecutionDetail 结果推送卡片', () => {
  it.each([
    ['pushed', '结果已推送'],
    ['duplicate', '内容与上次相同，未重复推送'],
    ['empty-body', '没有可推送的正文，未推送'],
    ['empty-result', '这次运行没有产出结果，未推送'],
    ['observe-mode', '观察模式：已拦下，未推送'],
    ['quiet-watch-round', '没有新内容，未推送'],
    ['notify-quiet-round', '未达到通知条件，未推送'],
  ] as const)('%s → %s（中性卡片，不在 error 区）', (pushNote, sentence) => {
    render(<CronExecutionDetail execution={execution({ pushNote })} />);
    expect(screen.getByTestId('cron-push-note-sentence').textContent).toBe(sentence);
    expect(screen.getByTestId('cron-push-note-detail').textContent).toContain('结果推送');
    expect(screen.getByTestId('cron-push-note-detail').className).not.toMatch(/red/);
  });

  it('en copy', () => {
    language.value = 'en';
    render(<CronExecutionDetail execution={execution({ pushNote: 'duplicate' })} />);
    expect(screen.getByTestId('cron-push-note-sentence').textContent).toBe('Content identical to the last push; not pushed again');
  });

  it('hidden when pushNote is undefined', () => {
    render(<CronExecutionDetail execution={execution()} />);
    expect(screen.queryByTestId('cron-push-note-detail')).toBeNull();
  });
});
