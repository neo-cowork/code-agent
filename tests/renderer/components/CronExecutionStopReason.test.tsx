// @vitest-environment jsdom
// N-FIX-PARKED-APPROVAL-SURVIVE-RESTART-REALRUN-FU2 ②：运行详情给 interrupted/failed 的 run 显示「为什么停了」，
// 句子逐字来自 host（与收件箱同一句）。
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeDomain = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain } }));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: { listJobs: vi.fn(), getStats: vi.fn(), getExecutions: vi.fn(), getRecentExecutions: vi.fn(), triggerJob: vi.fn() },
}));
const language = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh, en } = await import('../../../src/renderer/i18n');
  return {
    useI18n: () => ({
      language: language.value,
      t: language.value === 'zh' ? zh : en,
    }),
  };
});

import type { CronJobExecution } from '@shared/contract';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';
import { describeParkedApprovalClosure } from '../../../src/host/agent/parkedApprovalSurvival';
import { PARKED_APPROVAL_CLOSURE_SENTENCES } from '../../../src/shared/parkedApprovalClosure';

const CLOSURE_CASES = [
  {
    key: 'expiredAfterRestart24h',
    sentence: describeParkedApprovalClosure('expired_after_restart_24h'),
  },
  {
    key: 'workingDirectoryUnavailable',
    sentence: describeParkedApprovalClosure('args_unavailable', 'working_directory_unavailable'),
  },
  {
    key: 'runEndedAfterRestart',
    sentence: describeParkedApprovalClosure('run_ended_after_restart'),
  },
  {
    key: 'argsUnavailable',
    sentence: describeParkedApprovalClosure('args_unavailable'),
  },
] as const satisfies ReadonlyArray<{
  key: keyof typeof PARKED_APPROVAL_CLOSURE_SENTENCES;
  sentence: string;
}>;
const execution = (o: Partial<CronJobExecution> = {}): CronJobExecution => ({
  id: 'exec-1', jobId: 'job-1', runsOn: 'local', status: 'interrupted', scheduledAt: 1, retryAttempt: 0,
  sessionId: 'sess-1', ...o,
});

afterEach(() => { cleanup(); invokeDomain.mockReset(); language.value = 'zh'; });

describe('CronExecutionDetail 为什么停了', () => {
  it.each(CLOSURE_CASES)('② %s：zh 显示原句，en 显示对应英文句', async ({ key, sentence }) => {
    invokeDomain.mockResolvedValue(sentence);
    const { container } = render(<CronExecutionDetail execution={execution()} />);
    await waitFor(() => expect(screen.getByTestId('cron-exec-stop-reason')).toBeTruthy());
    expect(invokeDomain).toHaveBeenCalledWith('domain:sessionAutomation', 'getVoidedApprovalReason', { sessionId: 'sess-1' });
    console.log(`[DOM zh] ${screen.getByTestId('cron-exec-stop-reason').textContent}`);
    expect(screen.getByTestId('cron-exec-stop-reason-text').textContent).toBe(sentence);
    expect(container.textContent).toContain(sentence);
    cleanup();

    language.value = 'en';
    invokeDomain.mockResolvedValue(sentence);
    render(<CronExecutionDetail execution={execution({ status: 'failed' })} />);
    await waitFor(() => expect(screen.getByTestId('cron-exec-stop-reason')).toBeTruthy());
    console.log(`[DOM en] ${screen.getByTestId('cron-exec-stop-reason').textContent}`);
    const enTranslation = (await import('../../../src/renderer/i18n/en')).en.toolStepHumanize.parkedClosure[key];
    expect(screen.getByTestId('cron-exec-stop-reason-text').textContent).toBe(enTranslation);
    expect(screen.getByTestId('cron-exec-stop-reason').textContent).toBe(`Why it stopped${enTranslation}`);
  });

  it('② 未识别句子在 zh / en 都原样显示', async () => {
    const raw = 'A raw persisted reason that is not a parked-approval closure sentence.';
    invokeDomain.mockResolvedValue(raw);
    render(<CronExecutionDetail execution={execution()} />);
    await waitFor(() => expect(screen.getByTestId('cron-exec-stop-reason-text').textContent).toBe(raw));
    expect(screen.getByTestId('cron-exec-stop-reason-text').textContent).toBe(raw);

    cleanup();
    language.value = 'en';
    invokeDomain.mockResolvedValue(raw);
    render(<CronExecutionDetail execution={execution({ status: 'failed' })} />);
    await waitFor(() => expect(screen.getByTestId('cron-exec-stop-reason-text').textContent).toBe(raw));
    expect(screen.getByTestId('cron-exec-stop-reason-text').textContent).toBe(raw);
  });

  it('无原因 / completed / 无 sessionId：不渲染也不查询；查询报错不崩', async () => {
    invokeDomain.mockResolvedValue(null);
    const { rerender } = render(<CronExecutionDetail execution={execution()} />);
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('cron-exec-stop-reason')).toBeNull();
    rerender(<CronExecutionDetail execution={execution({ status: 'completed' })} />);
    rerender(<CronExecutionDetail execution={execution({ sessionId: undefined })} />);
    expect(invokeDomain).toHaveBeenCalledTimes(1);
    invokeDomain.mockRejectedValue(new Error('boom'));
    rerender(<CronExecutionDetail execution={execution({ sessionId: 'sess-2' })} />);
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('cron-exec-stop-reason')).toBeNull();
  });
});
