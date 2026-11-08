// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBackgroundTaskRecoveryPlan } from '../../../src/host/task/backgroundTaskRecoveryPlan';
import { TaskDashboardSummary } from '../../../src/renderer/components/TaskPanel/RunWorkbenchCards';
import { buildLedgerTaskRecords } from '../../../src/renderer/hooks/useRunWorkbenchModel';
import type { Task } from '../../../src/shared/contract/backgroundTask';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

afterEach(() => cleanup());

describe('background task Automation prompt reason row', () => {
  it('renders the full flagged reason in the DOM and title with a three-line clamp', () => {
    const recoveryPlan = buildBackgroundTaskRecoveryPlan({
      status: 'failed',
      recoveryStatus: 'failed',
      outputFile: '/tmp/automation-prompt.log',
      exitCode: 1,
      automationPromptLikely: true,
      locale: 'zh',
    });
    const task: Task = {
      id: 'shell:automation-prompt',
      kind: 'shell',
      sessionId: 'session-1',
      source: 'shell',
      title: '读取联系人',
      status: 'failed',
      createdAt: 1,
      updatedAt: 2,
      events: [],
      outputRefs: [],
      metadata: { recoveryPlan },
    };
    const records = buildLedgerTaskRecords([task], 'session-1');
    const fullText = `原因：${recoveryPlan.summary}`;

    render(<TaskDashboardSummary tasks={records} run={null} />);

    const reasonRow = screen.getByTitle(fullText);
    expect(reasonRow.textContent).toBe(fullText);
    expect(reasonRow.classList.contains('line-clamp-3')).toBe(true);
    expect(reasonRow.classList.contains('truncate')).toBe(false);
    expect(reasonRow.textContent).toContain('授权框');
    expect(reasonRow.textContent).toContain('请手动点掉或点「不允许」');
  });
});
