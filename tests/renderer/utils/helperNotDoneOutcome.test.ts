// 助手自报 failed / partial（结构化 outcome）时：任务卡、成员栏行、后台任务面板行一律「没做完」，
// 折叠面只有一句本界面语言的话；它名下被掩盖退出码的 Bash 行也不报完成。
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import type { AgentTreeNode } from '../../../src/shared/contract/agentTree';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import { deriveDelegationPresentation } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { backgroundTaskFailureCopy } from '../../../src/renderer/utils/agentFailureCopy';
import { buildAgentRows } from '../../../src/renderer/utils/agentRows';

afterEach(() => useAppStore.setState({ language: 'zh' }));

const RAW = /cp |No such file|exit|\/Users\/|COMMAND_FAILED/;

function helperTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1', sessionId: 'session-1', source: 'session_command_center', title: '把报告复制到归档文件夹',
    status: 'failed', createdAt: 1, updatedAt: 2, events: [], outputRefs: [],
    failure: {
      message: '这个后台任务没有做完：中间有一步没做成。补上缺少的内容后，可以让我再试一次。',
      reason: 'session_command_task_failed',
      outcome: { status: 'failed', reason: 'cp: /Users/x/missing-report.txt: No such file or directory' },
    },
    progress: { bashSteps: [{ command: 'cp missing-report.txt archive/; echo "---exit:$?---"', callId: 'call-cp' }] },
    ...overrides,
  };
}

const delegateCall: ToolCall = {
  id: 'call-delegate', name: 'delegate_task', arguments: { title: '把报告复制到归档文件夹' },
  result: {
    toolCallId: 'call-delegate', success: true, output: 'started',
    metadata: { sessionTask: { outcome: 'accepted', tasks: [{ taskId: 'task-1', shortName: '归档', status: 'running' }] } },
  },
};

describe('helper reported not done', () => {
  it.each([
    ['zh', zh], ['en', en],
  ] as const)('task card, panel row and failure copy say not done in %s without raw internals', (language, t) => {
    useAppStore.setState({ language });
    const task = helperTask();
    const card = deriveDelegationPresentation(delegateCall, [task], [], t);
    expect(card?.state).toBe('failed');
    expect(card?.failure).toBe(t.backgroundPanel.helperNotDone.failed);
    const [row] = buildAgentRows({ members: [], nodes: [], tasks: [task] });
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe(t.backgroundPanel.helperNotDone.failed);
    for (const collapsed of [card?.failure, row.failureReason, row.name, card?.title]) expect(collapsed).not.toMatch(RAW);
    expect(backgroundTaskFailureCopy(task, t)).toBe(t.backgroundPanel.helperNotDone.failed);
  });

  it.each([
    ['zh', zh, '工作目录里没有 missing-report.txt 这个文件，复制这一步没有做成', '这个后台任务没有做完：工作目录里没有 missing-report.txt 这个文件，复制这一步没有做成。补上缺少的内容后，可以让我再试一次。'],
    ['en', en, 'missing-report.txt is not in the workspace, so the copy step did not run', 'This background task is not done: missing-report.txt is not in the workspace, so the copy step did not run. Add what is missing and I can try again.'],
  ] as const)('a safe helper reason names the failed step on card, rail and panel row in %s', (language, t, reason, sentence) => {
    useAppStore.setState({ language });
    const task = helperTask({ failure: { message: 'x', outcome: { status: 'failed', reason } } });
    expect(deriveDelegationPresentation(delegateCall, [task], [], t)?.failure).toBe(sentence);
    const [row] = buildAgentRows({ members: [], nodes: [], tasks: [task] });
    expect(row.failureReason).toBe(sentence);
    expect(backgroundTaskFailureCopy(task, t)).toBe(sentence);
  });

  it('a reason in the wrong language or with raw command / stderr falls back to the generic sentence', () => {
    for (const reason of ['源文件不存在', 'cp missing-report.txt archive/ failed', 'No such file or directory']) {
      expect(backgroundTaskFailureCopy(helperTask({ failure: { message: 'x', outcome: { status: 'failed', reason } } }), en))
        .toBe(en.backgroundPanel.helperNotDone.failed);
    }
    expect(backgroundTaskFailureCopy(helperTask({ failure: { message: 'x', outcome: { status: 'failed', reason: 'The source file is missing' } } }), zh))
      .toBe(zh.backgroundPanel.helperNotDone.failed);
  });

  it('partial uses the partial sentence', () => {
    const task = helperTask({ failure: { message: 'x', outcome: { status: 'partial' } } });
    expect(backgroundTaskFailureCopy(task, zh)).toBe(zh.backgroundPanel.helperNotDone.partial);
    expect(backgroundTaskFailureCopy(task, en)).toBe(en.backgroundPanel.helperNotDone.partial);
  });

  it('member rail: a linked agent node that says completed is overridden to failed', () => {
    const node: AgentTreeNode = {
      id: 'task-1', role: '归档', status: 'completed', statusLabel: '已完成',
      children: [], worktreeState: { status: 'none' }, budgetSummary: {}, evidenceRefs: [], sources: ['backgroundRegistry'],
    };
    const [row] = buildAgentRows({ members: [], nodes: [node], tasks: [helperTask()] });
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe(zh.backgroundPanel.helperNotDone.failed);
    expect(row.stoppable).toBe(false);
  });

  it('masked exit: the helper-owned shell row (toolCallId = helper bashSteps callId) does not show done', () => {
    const shell: Task = {
      id: 'shell:7', sessionId: 'session-1', source: 'shell', title: 'cp', status: 'completed', toolCallId: 'call-cp',
      createdAt: 1, updatedAt: 2, events: [], outputRefs: [], metadata: { exitCode: 0 },
    };
    const other: Task = { ...shell, id: 'shell:8', toolCallId: 'call-other' };
    const rows = buildAgentRows({ members: [], nodes: [], tasks: [helperTask(), shell, other] });
    expect(rows.find((row) => row.key === 'shell:7')?.status).toBe('failed');
    expect(rows.find((row) => row.key === 'shell:7')?.failureReason).toBe(zh.backgroundPanel.shellOfNotDoneTask);
    expect(rows.find((row) => row.key === 'shell:7')?.task?.metadata?.exitCode).toBe(0);
    expect(rows.find((row) => row.key === 'shell:8')?.status).toBe('done');
  });

  it('no outcome field: a completed helper stays done, never guessed from text', () => {
    const task = helperTask({ status: 'completed', failure: undefined, summary: 'The copy did not happen.' });
    const [row] = buildAgentRows({ members: [], nodes: [], tasks: [task] });
    expect(row.status).toBe('done');
  });
});
