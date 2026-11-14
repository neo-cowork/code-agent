// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import type { ToolCall } from '../../../src/shared/contract';
import { deriveDelegationPresentation, toDelegationDisplayToolCall } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';
import { DelegationReceipt } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/DelegationReceipt';
import { getToolStatusLabel } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/statusLabels';

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ openPreview: vi.fn(), openSettingsTab: vi.fn() }),
    { getState: () => ({ language: 'zh' as const }) },
  ),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';

afterEach(cleanup);

const report = 'Recovery has not been tested.\nPayment failures are not monitored.';
function taskCall(extraOutput = report, name = 'Task'): ToolCall {
  return {
    id: 'risk-review', name, arguments: {},
    result: {
      toolCallId: 'risk-review', success: true,
      output: `Agent [Explorer] completed:\n\n${report}\n\nStats:\n- Iterations: 2`,
      metadata: { artifactRole: 'multiagent-result', result: { output: extraOutput, iterations: 2 } },
    },
  };
}

describe('delegation report display projection', () => {
  it('omits a whitespace-equivalent second report from the display copy, retaining the stored field', () => {
    const call = taskCall('  Recovery has not been tested.\r\n\tPayment failures are not monitored.  ');
    const stored = JSON.stringify(call);
    const visible = toDelegationDisplayToolCall(call, zh);
    expect(visible.result?.metadata?.result).toEqual({ iterations: 2 });
    expect(JSON.stringify(call)).toBe(stored);
    expect(visible.result?.output).toBe(report);
    const html = renderToStaticMarkup(<ToolDetails compact toolCall={visible} />);
    expect(html.split('Recovery has not been tested.')).toHaveLength(2);
  });

  it.each([
    'Recovery has not been tested.\nPayment failures ARE monitored.',
    'Recovery has not been tested.',
    '',
  ])('retains genuinely different output: %s', (different) => {
    const call = taskCall(different);
    expect(toDelegationDisplayToolCall(call, zh).result?.metadata?.result).toEqual({ output: different, iterations: 2 });
  });

  it('compares the complete visible output as well as the report inside its envelope', () => {
    const call = taskCall();
    const nested = call.result!.metadata!.result as Record<string, unknown>;
    nested.output = call.result!.output;
    expect(toDelegationDisplayToolCall(call, zh).result?.metadata?.result).toEqual({ iterations: 2 });
  });

  it('handles the spawn_agent task/result envelope without discarding task text from storage', () => {
    const call = taskCall(report, 'spawn_agent');
    call.result!.output = `Agent [Explorer] completed task:\n\nTask: Review notes.\n\nResult:\n${report}\n\nStats:\n- Iterations: 2`;
    const stored = JSON.stringify(call);
    const visible = toDelegationDisplayToolCall(call, zh);
    expect(visible.result?.metadata?.result).toEqual({ iterations: 2 });
    expect(JSON.stringify(call)).toBe(stored);
  });

  it('retains failure metadata when no successful report is displayed', () => {
    const call = taskCall();
    call.result!.success = false;
    call.result!.error = 'Review interrupted';
    expect(toDelegationDisplayToolCall(call, zh).result?.metadata?.result).toEqual({ output: report, iterations: 2 });
  });

  it('compares content even without a decorated Task envelope', () => {
    const call = taskCall(report, 'AgentSpawn');
    call.result!.output = report;
    expect(toDelegationDisplayToolCall(call, zh).result?.metadata?.result).toEqual({ iterations: 2 });
  });
});

const storedReportOutput = "Agent [Explorer] completed task:\n\nTask: Read the file notes.txt in the working directory (/tmp/review-workspace/notes.txt). Identify and list the THREE biggest risks described in it. For each risk give: a short risk name, what it is, why it matters (potential impact), and the line number(s) in notes.txt where you found the evidence. Do not invent anything not present in the file. Return a concise structured summary I can relay to a non-programmer user.\n\nResult:\n## Three Biggest Risks in notes.txt\n\nAll evidence is on **line 1** of notes.txt (the file is a single line of text).\n\n**1. No tested backup restoration process**\n- **What it is:** The release has no backup restoration process that has been tested.\n- **Why it matters:** If data is lost or corrupted, there's no proven way to get it back — recovery could fail or take much longer than expected.\n- **Evidence:** line 1\n\n**2. Shared customer data access for the whole team**\n- **What it is:** Access to customer data is shared across the entire team (no individual/limited access).\n- **Why it matters:** Increases the risk of accidental or intentional misuse, and makes it hard to trace who accessed or changed what.\n- **Evidence:** line 1\n\n**3. No monitoring for failed payment transactions**\n- **What it is:** The payment integration has no monitoring in place for failed transactions.\n- **Why it matters:** Failed payments could go unnoticed, leading to lost revenue, unpaid orders, and customers not being notified.\n- **Evidence:** line 1\n\n---\n\n**Note:** The file also mentions a broken office coffee machine (line 1), but that's not a project/customer risk, so it's excluded from the top three.\n\n**Relevant file paths:**\n- /tmp/review-workspace/notes.txt\n\nStats:\n- Iterations: 2\n- Tools used: Read\n- Agent ID: agent_explore_4ce9cbd1-9d6b-4616-bada-30b53825e99f\n- Pipeline ID: agent_explore_4ce9cbd1-9d6b-4616-bada-30b53825e99f\n- Cost: $0.0000";

describe('human-facing subagent result cards', () => {
  it.each(['Task', 'spawn_agent', 'AgentSpawn'])('renders the stored %s report once without bookkeeping or absolute paths', (name) => {
    const output = name === 'Task'
      ? `Agent [Explorer] completed (review):\n\n${storedReportOutput.split('\n\nResult:\n')[1]}`
      : storedReportOutput;
    const call: ToolCall = {
      id: 'stored-risk-review', name, arguments: { task: 'Review /tmp/review-workspace/notes.txt' },
      result: { toolCallId: 'stored-risk-review', success: true, output,
        metadata: { tool: name, artifactRole: 'multiagent-result', result: { agentId: 'review-agent' } } },
    };
    const original = JSON.stringify(call);
    const visible = toDelegationDisplayToolCall(call, zh);
    const view = render(<ToolDetails compact toolCall={visible} />);
    const expand = view.queryByRole('button', { name: /展开剩余/ });
    if (expand) fireEvent.click(expand);
    const text = view.container.textContent ?? '';
    expect(text.split('The release has no backup restoration process that has been tested.')).toHaveLength(2);
    for (const token of ['Agent [Explorer]', 'Task:', 'Result:', 'Stats:', 'Iterations:', 'Tools used:', '/tmp/review-workspace']) {
      expect(text).not.toContain(token);
    }
    expect(text).toContain('notes.txt');
    expect(JSON.stringify(visible.arguments)).not.toContain('/tmp/');
    expect(JSON.stringify(call)).toBe(original);
  });
});

it.each([zh, en])('localizes background receipts without exposing task ids or polling instructions', (t) => {
  for (const name of ['Task', 'spawn_agent', 'AgentSpawn']) {
    for (const output of [
      'Agent [Explorer] exceeded foreground budget and continues in background:\n- task_id=review-agent\n- status=running\n- foreground_budget_ms=1000\nUse collect_agent("review-agent") to fetch the result.',
      'Agent [Explorer] spawned in background:\n- Agent ID: review-agent\n- Task: Review /tmp/project/notes.txt\n- Status: running\nUse wait_agent to wait.',
      '已在后台开始处理「检查计划」，完成后会通知你。\n- Agent ID: review-agent',
    ]) {
      const call = taskCall('', name);
      call.result!.output = output;
      const original = JSON.stringify(call);
      const projected = toDelegationDisplayToolCall(call, t);
      // No live child fact → no "working" claim either.
      expect(projected.result?.output).toBe('');
      expect(JSON.stringify(call)).toBe(original);
    }
  }
});

it.each([zh, en])('renders wait_agent reports and localized pending states without bookkeeping', (t) => {
  const call = taskCall('', 'wait_agent');
  call.result!.output = `Wait results (timeout):\n\n✅ [review-agent] explore — completed (1200ms)\n   Result: ${report}\n   /tmp/project/notes.txt\n   Stats: 2 iterations, 1 tools, $0.0000\n\n⏳ [pending-agent] explore — running (1000ms)\n   Still in progress after 1000ms timeout`;
  const original = JSON.stringify(call);
  const projected = toDelegationDisplayToolCall(call, t);
  const view = render(<ToolDetails compact toolCall={projected} />);
  const text = view.container.textContent ?? '';
  expect(text.split('Recovery has not been tested.')).toHaveLength(2);
  expect(text).toContain(t.chat.delegationReceipt.working);
  expect(text).toContain('notes.txt');
  for (const token of ['Wait results', 'Result:', 'Stats:', 'iterations', 'review-agent', 'pending-agent', '/tmp/project']) {
    expect(text).not.toContain(token);
  }
  expect(JSON.stringify(call)).toBe(original);
});

it('shortens local paths in report and title while preserving links and relative paths', () => {
  const call = taskCall('', 'spawn_agent');
  call.result!.output = 'Read "/tmp/review plan/notes.txt" and C:\\work\\plan.txt; see https://example.com/home/notes.txt and ./notes.txt.';
  call.shortDescription = 'Review /tmp/project/notes.txt';
  const projected = toDelegationDisplayToolCall(call, zh);
  expect(projected.result?.output).toBe('Read "notes.txt" and plan.txt; see https://example.com/home/notes.txt and ./notes.txt.');
  expect(projected.shortDescription).toBe('Review notes.txt');
});


it.each([zh, en])('uses the localized action instead of a model-authored internal tool name', (t) => {
  const call = taskCall('', 'spawn_agent');
  call.shortDescription = 'Use spawn_agent';
  const projected = toDelegationDisplayToolCall(call, t);
  expect(projected.shortDescription).toBeUndefined();
  expect(humanizeToolStep(projected.name, projected.arguments, t, projected.shortDescription))
    .toBe(t.toolStepHumanize.subagentSpawnFallback);
  expect(call.shortDescription).toBe('Use spawn_agent');
});

describe('delegation report keeps actionable stats notes', () => {
  it('shows worktree branch and missing-tools lines but not other stats', () => {
    const call = taskCall();
    call.name = 'spawn_agent';
    call.result!.output = `Agent [Explorer] completed task:\n\nTask: Fix it.\n\nResult:\n${report}\n\nStats:\n- Iterations: 2\n- Tools used: Read\n- Agent ID: a1\n- Missing tools: Grep（声明的工具未全部装配，该子代理能力可能不完整）\n- Worktree: preserved at /tmp/wt/agent-1 (branch: agent/a1) — review and merge changes`;
    const out = toDelegationDisplayToolCall(call, zh).result?.output ?? '';
    expect(out).toContain('Missing tools: Grep');
    expect(out).toContain('branch: agent/a1');
    expect(out).toContain('review and merge changes');
    expect(out).not.toContain('/tmp/wt');
    for (const token of ['Stats:', 'Iterations:', 'Tools used:', 'Agent ID']) expect(out).not.toContain(token);
  });
});

describe('background hand-off row', () => {
  it.each(['', '\n', '（', '：', '，', '「', '【', '、'])('shortens paths after %j in every projected surface', (prefix) => {
    const call = taskCall('', 'spawn_agent');
    const text = `${prefix}/Users/tester/project/notes.md）`;
    const expected = `${prefix}notes.md）`;
    call.arguments = { task: text };
    call.shortDescription = text;
    call.result!.output = text;
    const stored = JSON.stringify(call);
    const projected = toDelegationDisplayToolCall(call, zh);
    expect(projected.arguments.task).toBe(expected);
    expect(projected.shortDescription).toBe(expected);
    expect(projected.result?.output).toBe(expected);
    expect(humanizeToolStep(projected.name, projected.arguments, zh)).not.toContain('/Users/');
    expect(JSON.stringify(call)).toBe(stored);
  });

  it('keeps CJK punctuation between adjacent paths and preserves public URLs', () => {
    const call = taskCall('', 'spawn_agent');
    call.result!.output = '阅读（/tmp/project/a.md、/tmp/project/b.md），参考：https://example.com/Users/team/notes.md';
    expect(toDelegationDisplayToolCall(call, zh).result?.output)
      .toBe('阅读（a.md、b.md），参考：https://example.com/Users/team/notes.md');
  });

  it.each([zh, en])('labels a projected background receipt as dispatched, not completed', (t) => {
    const call = taskCall('', 'spawn_agent');
    call.result!.output = 'Agent [Explorer] exceeded foreground budget and continues in background:\n- status=running';
    call.result!.metadata = { background: true, transferredToBackground: true };
    const projected = toDelegationDisplayToolCall(call, t);
    // No live child fact: neither "working" nor "completed" is claimed.
    expect(projected.result?.output).toBe('');
    expect(getToolStatusLabel(projected, 'success', t)).toBe(t.chat.delegationReceipt.dispatched);
    expect(getToolStatusLabel(taskCall('', 'spawn_agent'), 'success', t)).toBe(t.chat.delegationReceipt.completed);
  });

  it.each([[zh, 'completed'], [en, 'completed'], [zh, 'failed'], [en, 'failed']] as const)(
    'replaces the stored "working" hand-off text once the child finished (%#)',
    (t, state) => {
      const call = taskCall('', 'spawn_agent');
      call.result!.output = 'Agent [Explorer] exceeded foreground budget and continues in background:\n- status=running';
      call.result!.metadata = { background: true, transferredToBackground: true };
      const stored = JSON.stringify(call);
      expect(toDelegationDisplayToolCall(call, t, { state }).result?.output).toBe(t.chat.delegationReceipt[state]);
      expect(toDelegationDisplayToolCall(call, t, { state: 'working' }).result?.output).toBe(t.chat.delegationReceipt.working);
      expect(JSON.stringify(call)).toBe(stored);
    },
  );

  it('derives the branch to merge from a preserved worktree on a finished agent node only', () => {
    const call = taskCall('', 'spawn_agent');
    call.result!.output = 'x';
    call.result!.metadata = { agentId: 'agent-1' };
    const node = (status: string, worktree: string) => ({
      id: 'agent-1', role: 'coder', status, statusLabel: '', children: [], evidenceRefs: [], sources: [],
      budgetSummary: {}, worktreeState: { status: worktree, branch: 'agent/agent-1' },
    }) as never;
    expect(deriveDelegationPresentation(call, [], [node('completed', 'preserved')])?.branch).toBe('agent/agent-1');
    expect(deriveDelegationPresentation(call, [], [node('completed', 'cleaned')])?.branch).toBeUndefined();
    expect(deriveDelegationPresentation(call, [], [node('running', 'preserved')])?.branch).toBeUndefined();
  });

  it('renders the branch line in the finished receipt', () => {
    const { getByTestId } = render(
      <DelegationReceipt presentation={{ state: 'completed', title: 't', outputs: [], activityIds: [], branch: 'agent/agent-1' }} />,
    );
    expect(getByTestId('delegation-branch').textContent).toBe(zh.chat.delegationReceipt.mergeBranch.replace('{branch}', 'agent/agent-1'));
  });
});
