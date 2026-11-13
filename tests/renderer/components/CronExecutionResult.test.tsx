// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJobExecution } from '@shared/contract';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';
import { useAppStore } from '../../../src/renderer/stores/appStore';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn() },
}));

const agent = (overrides: Record<string, unknown> = {}) => ({
  agentType: 'code', prompt: '整理今天的待办', sessionId: 'session-result', ...overrides,
});
const execution = (result: unknown): CronJobExecution => ({
  id: 'run-result', jobId: 'daily-todos', status: 'completed',
  scheduledAt: 1_800_000_000_000, retryAttempt: 0, result,
});

function resultBody() {
  const section = screen.getByTestId('cron-result');
  const technical = screen.getByTestId('cron-result-technical') as HTMLDetailsElement;
  const plain = Array.from(section.children)
    .filter((child) => child !== technical).map((child) => child.textContent).join('\n');
  expect(plain).not.toMatch(/agentType|sessionId|urgency|must_today|"prompt"|cron_summary|cron_snapshot|artifact:/);
  return { section, technical, plain };
}

afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); });

describe('CronExecutionDetail readable result', () => {
  it('shows declared urgency, cleaned summary, files and alert reason; folds raw data', () => {
    const result = agent({
      urgency: 'must_today',
      result: 'urgency: must_today\n<cron_snapshot>{"private":true}</cron_snapshot>\n<cron_summary>请在五点前确认周报。\nartifact: reports/weekly.md</cron_summary>',
      alertReason: '<cron_alert>周报今天到期。</cron_alert>',
    });
    render(<CronExecutionDetail execution={execution(result)} />);
    const { technical, plain } = resultBody();
    expect(plain).toContain('今日必办');
    expect(plain).toContain('请在五点前确认周报。');
    expect(plain).toContain('生成的文件');
    expect(plain).toContain('weekly.md');
    expect(plain).toContain('提醒原因：周报今天到期。');
    expect(plain).not.toContain('private');
    expect(technical.open).toBe(false);
    expect(technical.querySelector('pre')?.textContent?.trim()).toBe(JSON.stringify(result, null, 2));
    fireEvent.click(within(technical).getByText('查看技术详情'));
    expect(technical.open).toBe(true);
  });

  it('prefers full stored digest, cleans its header, and respects host-filtered artifacts', () => {
    render(<CronExecutionDetail execution={execution(agent({
      result: '<cron_summary>wrong\nartifact: read-only.txt</cron_summary>',
      digest: { fullSummary: 'urgency: can_wait\n完整工作摘要。', summary: '截断', artifacts: ['report.md', 'report.md', null] },
    }))} />);
    const { plain } = resultBody();
    expect(plain).toContain('完整工作摘要。');
    expect(plain).toContain('可以稍后');
    expect(plain).not.toMatch(/wrong|截断|read-only/);
    expect(screen.getByTestId('cron-result-artifacts').querySelectorAll('li')).toHaveLength(1);
  });

  it.each([
    { exitCode: 0, stdout: 'internal shell output' },
    { delivered: true, message: '明天下午三点发周报' },
    null, ['unknown'], 'unknown',
    agent({ result: { unexpected: true }, digest: { summary: 123, artifacts: 'bad' } }),
    agent({ result: '<cron_snapshot>{"machine":true}</cron_snapshot>\nurgency: maybe' }),
  ])('provides a plain no-text sentence for empty or unknown result %j', (result) => {
    render(<CronExecutionDetail execution={execution(result)} />);
    const { technical, plain } = resultBody();
    expect(plain).toContain('本次运行未产生文字结果。');
    expect(plain).not.toMatch(/exitCode|stdout|delivered|unexpected|machine/);
    expect(technical.open).toBe(false);
    expect(screen.queryByTestId('cron-result-urgency')).toBeNull();
  });

  it('does not invent urgency when the host normalized an undeclared header to fyi', () => {
    render(<CronExecutionDetail execution={execution(agent({ urgency: 'fyi', digest: { summary: '已整理待办。', artifacts: [] } }))} />);
    expect(screen.queryByTestId('cron-result-urgency')).toBeNull();
    expect(resultBody().plain).toContain('已整理待办。');
  });

  it('renders English copy and explicitly declared FYI without Chinese', () => {
    useAppStore.setState({ language: 'en' });
    render(<CronExecutionDetail execution={execution(agent({
      digest: { summary: 'urgency: fyi\nWeekly report is ready.', artifacts: ['weekly.md'] },
      alertReason: 'The report is due today.',
    }))} />);
    const { plain, technical } = resultBody();
    expect(plain).toContain('FYI');
    expect(plain).toContain('Weekly report is ready.');
    expect(plain).toContain('Generated files');
    expect(plain).toContain('Reason for the alert: The report is due today.');
    expect(plain).not.toMatch(/[\u3400-\u9fff]/);
    expect(within(technical).getByText('Technical details')).toBeTruthy();
  });

  it('renders the English no-text sentence for cloud results', () => {
    useAppStore.setState({ language: 'en' });
    render(<CronExecutionDetail execution={execution({ cloud: true, state: 'done' })} />);
    expect(resultBody().plain).toContain('This run produced no text result.');
  });
});
