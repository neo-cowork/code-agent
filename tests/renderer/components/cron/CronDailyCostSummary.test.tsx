// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CronJobExecution } from '@shared/contract';
import { CronDailyCostSummary } from '../../../../src/renderer/components/features/cron/CronDailyCostSummary';

const NOW = new Date(2026, 10, 13, 9).getTime();

function execution(overrides: Partial<CronJobExecution> = {}): CronJobExecution {
  return {
    id: 'run', jobId: 'job', status: 'completed', runsOn: 'local',
    scheduledAt: NOW, startedAt: NOW, retryAttempt: 0, ...overrides,
  };
}

afterEach(cleanup);

describe('CronDailyCostSummary missing cost', () => {
  it.each([
    ['shell', { result: { stdout: 'report ready', stderr: '' } }],
    ['webhook', { result: { status: 200, body: 'accepted' } }],
    ['ipc', { status: 'failed', error: 'unsupported_action' }],
    ['memory-consolidation', { result: { applied: false, actions: [] } }],
    ['no-product wake', { result: { roleId: 'role-a', trigger: 'cadence', status: 'completed', decision: 'silence' } }],
    ['skipped wake', { result: { status: 'skipped', skipReason: 'quiet_hours' } }],
    ...(['pending', 'running', 'paused'] as const).map((status) => [status, { status, sessionId: 'in-flight' }] as const),
  ] satisfies ReadonlyArray<readonly [string, Partial<CronJobExecution>]>)(
    'keeps the recorded amount beside a costless %s execution', (_name, overrides) => {
      render(<CronDailyCostSummary executions={[execution({ cost: 0.03 }), execution(overrides)]} />);
      expect(screen.getByTestId('cron-daily-cost-summary').textContent).toContain('$0.0300');
      expect(screen.getByTestId('cron-daily-cost-summary').textContent).not.toContain('成本未完整记录');
    },
  );

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'still marks a %s model-session execution with missing cost as incomplete', (status) => {
      render(<CronDailyCostSummary executions={[
        execution({ cost: 0.03 }), execution({ status, sessionId: 'model-session' }),
      ]} />);
      expect(screen.getByTestId('cron-daily-cost-summary').textContent).toContain('成本未完整记录');
    },
  );

  it('recognizes a wake session in result even when the model completed silently', () => {
    render(<CronDailyCostSummary executions={[
      execution({ cost: 0.03 }),
      execution({ result: { roleId: 'role-a', status: 'completed', decision: 'silence', sessionId: 'wake-session' } }),
    ]} />);
    expect(screen.getByTestId('cron-daily-cost-summary').textContent).toContain('成本未完整记录');
  });

  it('does not let cloud missing costs hide local spend and accepts explicit zero cost', () => {
    render(<CronDailyCostSummary executions={[
      execution({ cost: 0.03 }), execution({ cost: 0, sessionId: 'zero-cost' }),
      execution({ runsOn: 'cloud', sessionId: 'cloud-session' }),
    ]} />);
    expect(screen.getByTestId('cron-daily-cost-summary').textContent).toContain('$0.0300');
  });

  it('marks only the day with a missing model-session cost as incomplete', () => {
    render(<CronDailyCostSummary executions={[
      execution({ cost: 0.03 }),
      execution({ startedAt: new Date(2026, 10, 12, 9).getTime(), sessionId: 'yesterday-session' }),
    ]} />);
    const days = screen.getAllByTestId('cron-daily-cost-summary-day');
    expect(days[0].textContent).toContain('$0.0300');
    expect(days[1].textContent).toContain('成本未完整记录');
  });

  describe('flat-fee (zero-priced model) runs', () => {
    const flat = (overrides: Partial<CronJobExecution> = {}) => execution({ flatFee: true, sessionId: 'flat-session', ...overrides });

    it('a day of only flat-fee runs reads "not billed in USD" with the run count, not "not fully recorded"', () => {
      render(<CronDailyCostSummary executions={[flat({ id: 'a' }), flat({ id: 'b' }), flat({ id: 'c', status: 'failed' })]} />);
      const text = screen.getByTestId('cron-daily-cost-summary').textContent;
      expect(text).toContain('不按美元计费 · 3 次');
      expect(text).not.toContain('成本未完整记录');
      expect(text).not.toContain('$');
    });

    it('a mixed day shows the USD sum of the priced runs only', () => {
      render(<CronDailyCostSummary executions={[execution({ cost: 0.03 }), flat()]} />);
      const text = screen.getByTestId('cron-daily-cost-summary').textContent;
      expect(text).toContain('$0.0300');
      expect(text).not.toContain('不按美元计费');
      expect(text).not.toContain('成本未完整记录');
    });

    it('an unmarked finished session with empty cost still makes the day incomplete next to flat-fee runs', () => {
      render(<CronDailyCostSummary executions={[flat(), execution({ id: 'lost', sessionId: 'priced-session' })]} />);
      expect(screen.getByTestId('cron-daily-cost-summary').textContent).toContain('成本未完整记录');
    });
  });
});
