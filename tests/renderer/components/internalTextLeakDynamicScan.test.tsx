// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CronEventDecision,
  CronJobDefinition,
  CronJobExecution,
  ToolCall,
} from '../../../src/shared/contract';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { TaskRecord } from '../../../src/renderer/types/runWorkbench';
import {
  detectInternalTextLeaks,
  type InternalTextFormat,
} from '../../../src/shared/humanizeInternalText';
import dynamicAllowlist from '../../../scripts/lib/internal-text-leak-dynamic-allowlist.json';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';
import { TaskDashboardSummary } from '../../../src/renderer/components/TaskPanel/RunWorkbenchCards';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';
import { CronEventDecisionsPanel } from '../../../src/renderer/components/features/cron/CronEventDecisionsPanel';

const cronClientMocks = vi.hoisted(() => ({
  getEventDecisions: vi.fn().mockResolvedValue([]),
  getEventActionModeChange: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
    getEventDecisions: cronClientMocks.getEventDecisions,
    getEventActionModeChange: cronClientMocks.getEventActionModeChange,
    triggerJob: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  cronClientMocks.getEventDecisions.mockReset();
  cronClientMocks.getEventDecisions.mockResolvedValue([]);
});

const LEAK_FIXTURES = {
  chatToolCall: {
    id: 'toolu_01A2B3C4D5E6F7G8H9',
    name: 'mcp__feishu__send_message',
    arguments: {
      recipient: 'ou_98a7b6c5d4e3f2a1',
      file: '/private/tmp/neo-run-98123/draft.md',
    },
    result: {
      toolCallId: 'toolu_01A2B3C4D5E6F7G8H9',
      success: true,
      output:
        'accepted：已向 ou_98a7b6c5d4e3f2a1 同步草稿（操作号 toolu_01A2B3C4D5E6F7G8H9，工具 memory_search / read_file）',
    },
  },
  backgroundTask: {
    id: 'bg-task-1',
    title:
      '[running] id=bg_42 · session_1762451092123_abcd12 · result was recorded · /tmp/bg-worker-log.txt',
    stepTitle: '后台任务正在执行：delegate_task 与 task_status',
  },
  automationRun: {
    execution: {
      id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      jobId: '8a112233-4455-6677-8899-aabbccddeeff',
      runsOn: 'local' as const,
      status: 'completed' as const,
      scheduledAt: 1_762_000_000_000,
      startedAt: 1_762_000_001_000,
      completedAt: 1_762_000_005_000,
      duration: 4_000,
      retryAttempt: 0,
      sessionId: 'session-work-20261107-alpha',
      result:
        'run result carried no eventDecisions · no outbound action attempted',
    },
    decisions: [
      {
        id: 'd-1',
        jobId: '8a112233-4455-6677-8899-aabbccddeeff',
        kind: 'event' as const,
        eventId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        decision: 'would_act' as const,
        reason: 'no outbound action attempted',
        matchedRule: 'mail message · account _icloud · mailbox INBOX',
        createdAt: 1_762_000_002_000,
      },
    ],
  },
  errorCard: {
    id: 'call_err_9988776655',
    name: 'bash',
    arguments: {
      command: 'sandbox-exec -f /tmp/seatbelt-profile.sb sh -c "npm test"',
    },
    result: {
      toolCallId: 'call_err_9988776655',
      success: false,
      error:
        'interrupted: process crashed · tool call was cancelled · sandbox-exec -f /tmp/seatbelt-profile.sb · {"code":"E_SANDBOX_CRASH","session":"session_1762451092123_abcd12"}',
    },
  },
};

type DynamicAllowlistEntry = {
  file: string;
  rule: InternalTextFormat;
  sample: string;
  reason: string;
};

function assertSurfaceHasOnlyExpectedLeaks(surface: string, visibleText: string) {
  const leaks = detectInternalTextLeaks(visibleText);
  const expected = (dynamicAllowlist as DynamicAllowlistEntry[]).filter(
    (entry) => entry.file === surface,
  );
  const unexpected = leaks.filter(
    (leak) =>
      !expected.some(
        (entry) => entry.rule === leak.format && entry.sample === leak.sample,
      ),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `[internal-text-leak-dynamic-scan] ${surface} has un-allowlisted visible leak(s):\n${unexpected
        .map((leak) => `  - [rule=${leak.format}] sample=${JSON.stringify(leak.sample)}`)
        .join('\n')}`,
    );
  }
  for (const entry of expected) {
    if (!leaks.some((leak) => leak.format === entry.rule && leak.sample === entry.sample)) {
      console.warn(
        `[internal-text-leak-dynamic-scan] ! expected leak no longer matches (can be tightened): ${surface} [${entry.rule}] "${entry.sample}" (${entry.reason})`,
      );
    }
  }
  return leaks;
}

describe('Internal-text leak dynamic scan across 4 key surfaces', () => {
  it('verifies raw fixtures contain all 9 internal leak formats before rendering', () => {
    const combinedRaw = JSON.stringify(LEAK_FIXTURES);
    const detected = new Set<InternalTextFormat>(
      detectInternalTextLeaks(combinedRaw).map((m) => m.format),
    );
    const allNine: InternalTextFormat[] = [
      'uuid',
      'session_id',
      'call_id',
      'ou_id',
      'internal_tool_name',
      'english_state_word',
      'sandbox_exec',
      'temp_path',
      'raw_json',
    ];
    for (const fmt of allNine) {
      expect(detected.has(fmt)).toBe(true);
    }
  });

  it('Surface 1 (Chat message / tool card): reports only ticket-owned leaks from a raw tool call', () => {
    const rawCall = LEAK_FIXTURES.chatToolCall;
    const rawToolCall: ToolCall = {
      id: rawCall.id,
      name: rawCall.name,
      arguments: rawCall.arguments,
      result: rawCall.result,
    };

    const traceNode: TraceNode = {
      id: 'node-1',
      type: 'tool_call',
      content: '',
      timestamp: 1_762_000_000_000,
      toolCall: {
        id: rawToolCall.id,
        name: rawToolCall.name,
        args: rawToolCall.arguments,
        result: String(rawToolCall.result?.output ?? ''),
        success: true,
      },
    };

    const { container } = render(
      <div>
        <ToolStepGroup nodes={[traceNode]} defaultExpanded={true} />
        <ToolDetails toolCall={rawToolCall} />
      </div>,
    );

    const visibleText = container.textContent || '';
    expect(visibleText.length).toBeGreaterThan(0);
    assertSurfaceHasOnlyExpectedLeaks('chat-tool-card', visibleText);
  });

  it('Surface 2 (Background-task card): reports only ticket-owned leaks from a raw task', () => {
    const rawBg = LEAK_FIXTURES.backgroundTask;
    const rawTasks: TaskRecord[] = [
      {
        id: rawBg.id,
        scope: 'global',
        title: rawBg.title,
        status: 'in_progress',
        steps: [
          {
            title: rawBg.stepTitle,
            status: 'in_progress',
          },
        ],
      },
    ];

    const { container } = render(<TaskDashboardSummary tasks={rawTasks} />);

    const visibleText = container.textContent || '';
    assertSurfaceHasOnlyExpectedLeaks('background-task-card', visibleText);
  });

  it('Surface 3 (Automation run record & event decisions): reports only ticket-owned leaks from raw records', async () => {
    const rawExec = LEAK_FIXTURES.automationRun.execution;
    const rawExecution: CronJobExecution = rawExec;

    const rawDecisions: CronEventDecision[] =
      LEAK_FIXTURES.automationRun.decisions.map((d) => ({
        ...d,
        eventId: d.eventId,
        reason: d.reason,
        matchedRule: d.matchedRule,
      }));
    cronClientMocks.getEventDecisions.mockResolvedValue(rawDecisions);

    const job: CronJobDefinition = {
      id: rawExecution.jobId,
      runsOn: 'local',
      name: '收件箱自动巡检',
      scheduleType: 'event',
      schedule: {
        type: 'event',
        source: 'connector',
        connector: 'mail',
        accountId: '_icloud',
        eventName: 'message',
      },
      action: { type: 'agent', agentType: 'default', prompt: '处理重要邮件' },
      enabled: true,
      actionMode: 'observe',
      createdAt: 1,
      updatedAt: 1,
    };

    const { container } = render(
      <div>
        <CronExecutionDetail execution={rawExecution} />
        <CronEventDecisionsPanel job={job} />
      </div>,
    );

    await waitFor(() =>
      expect(cronClientMocks.getEventDecisions).toHaveBeenCalled(),
    );

    const visibleText = container.textContent || '';
    assertSurfaceHasOnlyExpectedLeaks('automation-run-record', visibleText);
  });

  it('Surface 4 (Error card): reports only ticket-owned leaks from a raw tool error', () => {
    const rawErr = LEAK_FIXTURES.errorCard;
    const rawErrorCall: ToolCall = {
      id: rawErr.id,
      name: rawErr.name,
      arguments: rawErr.arguments,
      result: rawErr.result,
    };

    const { container } = render(<ToolDetails toolCall={rawErrorCall} />);

    // Also expand raw error details if a toggle is rendered so every visible string is scanned.
    const buttons = Array.from(container.querySelectorAll('button'));
    const rawErrorButton = buttons.find((b) =>
      b.textContent?.includes('查看原始报错'),
    );
    if (rawErrorButton) {
      fireEvent.click(rawErrorButton);
    }

    const visibleText = container.textContent || '';
    assertSurfaceHasOnlyExpectedLeaks('error-card', visibleText);
  });
});
