// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJobExecution } from '@shared/contract';
import { buildCronAgentActionResult } from '../../../src/host/cron/cronNormalizers';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';
import { useAppStore } from '../../../src/renderer/stores/appStore';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn() },
}));

function persistedAgentResult(
  finalAssistantText: string,
  options: {
    notifyWhen?: string;
    artifactContext?: Parameters<typeof buildCronAgentActionResult>[7];
  } = {},
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(buildCronAgentActionResult(
    {
      agentType: 'default',
      prompt: '整理今天的待办',
      ...(options.notifyWhen ? { notifyWhen: options.notifyWhen } : {}),
    },
    undefined,
    'session-result',
    finalAssistantText,
    false,
    false,
    undefined,
    options.artifactContext,
  ))) as Record<string, unknown>;
}

const execution = (result: unknown, overrides: Partial<CronJobExecution> = {}): CronJobExecution => ({
  id: 'run-result',
  jobId: 'daily-todos',
  sessionId: typeof (result as { sessionId?: unknown } | null)?.sessionId === 'string'
    ? (result as { sessionId: string }).sessionId
    : undefined,
  status: 'completed',
  scheduledAt: 1_800_000_000_000,
  retryAttempt: 0,
  result,
  ...overrides,
});

function resultBody() {
  const section = screen.getByTestId('cron-result');
  const technical = screen.getByTestId('cron-result-technical') as HTMLDetailsElement;
  const plain = Array.from(section.children)
    .filter((child) => child !== technical).map((child) => child.textContent).join('\n');
  expect(plain).not.toMatch(/agentType|sessionId|urgency|must_today|"prompt"|cron_summary|cron_snapshot|cron_alert|artifact:/);
  return { section, technical, plain };
}

afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); });

describe('CronExecutionDetail readable result', () => {
  it('shows declared urgency, cleaned summary, files and alert reason from persisted agent digest; folds raw data', () => {
    const result = persistedAgentResult(
      '<cron_snapshot>{"private":true}</cron_snapshot>\n<cron_alert>周报今天到期。</cron_alert>\n<cron_summary>\nurgency: must_today\n<cron_snapshot>{"nested":true}</cron_snapshot>\n请在五点前确认周报。\nartifact: reports/weekly.md\n</cron_summary>',
      { notifyWhen: '周报今天到期时提醒我' },
    );
    expect(result.result).toBeUndefined();
    expect(result.alertReason).toBe('周报今天到期。');
    render(<CronExecutionDetail execution={execution(result)} />);
    const { technical, plain } = resultBody();
    expect(plain).toContain('今日必办');
    expect(plain).toContain('请在五点前确认周报。');
    expect(plain).toContain('生成的文件');
    expect(plain).toContain('weekly.md');
    expect(plain).toContain('提醒原因：周报今天到期。');
    expect(plain).not.toMatch(/private|nested/);
    expect(technical.open).toBe(false);
    expect(technical.querySelector('pre')?.textContent?.trim()).toBe(JSON.stringify(result, null, 2));
    fireEvent.click(within(technical).getByText('查看技术详情'));
    expect(technical.open).toBe(true);
  });

  it('prefers full stored digest over truncated preview and respects host-filtered artifacts', () => {
    const tail = `${'补充说明。'.repeat(220)}末尾关键结论。`;
    const result = persistedAgentResult(
      `<cron_summary>\nurgency: can_wait\n开头预览。\n${tail}\nartifact: notes.txt\nartifact: reports/weekly.md\n</cron_summary>`,
      {
        artifactContext: {
          workingDirectory: '/workspace',
          messages: [
            { role: 'assistant', toolCalls: [{ id: 'r1', name: 'Read', arguments: { file_path: '/workspace/notes.txt' } }] },
            { role: 'tool', toolResults: [{ toolCallId: 'r1', success: true, output: 'todo' }] },
          ],
        },
      },
    );
    expect(result.result).toBeUndefined();
    expect(result.digest).toMatchObject({
      fullSummary: expect.stringContaining('末尾关键结论。'),
      artifacts: ['reports/weekly.md'],
    });
    render(<CronExecutionDetail execution={execution(result)} />);
    const { plain } = resultBody();
    expect(plain).toContain('开头预览。');
    expect(plain).toContain('末尾关键结论。');
    expect(plain).toContain('可以稍后');
    expect(plain).not.toContain('notes.txt');
    expect(screen.getByTestId('cron-result-artifacts').querySelectorAll('li')).toHaveLength(1);
    expect(screen.getByTestId('cron-result-artifacts').textContent).toContain('weekly.md');
  });

  it('directs the user to open the session when an agent run replied prose without <cron_summary>', () => {
    const proseOnly = persistedAgentResult('我已经把今天的待办整理在会话里了，请过目。');
    expect(proseOnly.digest).toEqual({ artifacts: [] });
    const { unmount } = render(<CronExecutionDetail execution={execution(proseOnly)} />);
    const first = resultBody().plain;
    expect(first).toContain('本次运行没有留下摘要，可打开会话查看。');
    expect(first).not.toContain('本次运行未产生文字结果。');
    expect(screen.getByTestId('cron-exec-detail-open-session')).toBeTruthy();
    expect(screen.queryByTestId('cron-result-urgency')).toBeNull();
    unmount();

    const deletedSessionRender = render(
      <CronExecutionDetail execution={execution(proseOnly, { sessionId: undefined })} />,
    );
    const deletedPlain = resultBody().plain;
    expect(deletedPlain).toContain('本次运行没有留下摘要。');
    expect(deletedPlain).not.toMatch(/可打开会话查看|本次运行未产生文字结果/);
    expect(screen.queryByTestId('cron-exec-detail-open-session')).toBeNull();
    deletedSessionRender.unmount();

    useAppStore.setState({ language: 'en' });
    render(<CronExecutionDetail execution={execution(proseOnly)} />);
    const enPlain = resultBody().plain;
    expect(enPlain).toContain('This run left no summary. Open the session to view it.');
    expect(enPlain).not.toMatch(/[\u3400-\u9fff]|produced no text result/);
  });

  it('keeps declared urgency when prose without a summary block leaves an empty persisted digest', () => {
    const result = persistedAgentResult('urgency: must_today\n今天五点前必须发周报。');
    expect(result.result).toBeUndefined();
    expect(result.digest).toEqual({ artifacts: [] });
    render(<CronExecutionDetail execution={execution(result)} />);
    const { plain } = resultBody();
    expect(plain).toContain('今日必办');
    expect(plain).toContain('本次运行没有留下摘要，可打开会话查看。');
    expect(plain).not.toContain('本次运行未产生文字结果。');
  });

  it('treats a digest containing only machine tags or an invalid urgency header as having no summary', () => {
    const result = persistedAgentResult('<cron_summary><cron_snapshot>{"machine":true}</cron_snapshot>\nurgency: maybe</cron_summary>');
    render(<CronExecutionDetail execution={execution(result)} />);
    const { plain } = resultBody();
    expect(plain).toContain('本次运行没有留下摘要，可打开会话查看。');
    expect(plain).not.toMatch(/machine|maybe|本次运行未产生文字结果/);
    expect(screen.queryByTestId('cron-result-urgency')).toBeNull();
  });

  it.each([
    { stdout: 'internal shell output', stderr: '' },
    { status: 200, body: 'webhook ok' },
    { roleId: 'r', trigger: 'cadence', status: 'skipped', skipReason: 'quiet_hours' },
    null,
    ['unknown'],
    'unknown',
  ])('provides a plain no-text sentence for non-agent or sessionless result %j', (result) => {
    render(<CronExecutionDetail execution={execution(result)} />);
    const { technical, plain } = resultBody();
    expect(plain).toContain('本次运行未产生文字结果。');
    expect(plain).not.toMatch(/stdout|webhook|quiet_hours|没有留下摘要/);
    expect(technical.open).toBe(false);
    expect(screen.queryByTestId('cron-result-urgency')).toBeNull();
  });

  it('handles a malformed persisted agent digest without rendering its raw fields', () => {
    const result = {
      ...persistedAgentResult('模型回复正文。'),
      digest: { summary: 123, artifacts: 'bad' },
    };
    render(<CronExecutionDetail execution={execution(result)} />);
    const { plain, technical } = resultBody();
    expect(plain).toContain('本次运行没有留下摘要，可打开会话查看。');
    expect(plain).not.toMatch(/123|bad/);
    expect(screen.queryByTestId('cron-result-artifacts')).toBeNull();
    expect(technical.open).toBe(false);
  });

  it('does not invent urgency when the host normalized an undeclared header to fyi', () => {
    const result = persistedAgentResult('<cron_summary>已整理待办。</cron_summary>');
    expect(result.urgency).toBe('fyi');
    render(<CronExecutionDetail execution={execution(result)} />);
    expect(screen.queryByTestId('cron-result-urgency')).toBeNull();
    expect(resultBody().plain).toContain('已整理待办。');
  });

  it('renders English copy and explicitly declared FYI without Chinese', () => {
    useAppStore.setState({ language: 'en' });
    const result = persistedAgentResult(
      '<cron_alert>The report is due today.</cron_alert>\n<cron_summary>urgency: fyi\nWeekly report is ready.\nartifact: weekly.md</cron_summary>',
      { notifyWhen: 'Alert when due' },
    );
    render(<CronExecutionDetail execution={execution(result)} />);
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
