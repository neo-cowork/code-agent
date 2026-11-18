// @vitest-environment jsdom
// N-FIX-CONTEXT-POPOVER-STALE-AND-AGENT-FAIL-UNNAMED-FU1-FU2:
// the chat receipt of a background spawn_agent follows the child's final state; a failed child
// carries two exits (view details / retry) and an unknown child never claims working/completed.

import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTreeNode, AgentTreeSnapshot } from '../../../src/shared/contract/agentTree';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { ToolCall } from '../../../src/shared/contract';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { DelegationReceipt } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/DelegationReceipt';
import type { DelegationPresentation } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';

interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

const mocks = vi.hoisted(() => ({
  tasks: [] as Task[],
  snapshot: null as AgentTreeSnapshot | null,
  language: 'zh' as 'zh' | 'en',
  currentSessionId: 'session-1' as string | null,
  running: new Set<string>(),
  messages: [] as StoredMessage[],
  sendPrompt: vi.fn(async (_content: string, _context?: { clientMessageId?: string }) => undefined),
}));

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: { getState: () => ({ sendPrompt: mocks.sendPrompt }) },
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: Task[] }) => unknown) => selector({ tasks: mocks.tasks }),
}));
vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: mocks.snapshot, refresh: vi.fn() }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      currentSessionId: mocks.currentSessionId,
      runningSessionIds: mocks.running,
      messages: mocks.messages,
    }),
    { getState: () => ({ currentSessionId: mocks.currentSessionId, messages: mocks.messages, switchSession: vi.fn() }) },
  ),
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign((selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      processingSessionIds: new Set<string>(),
      openPreview: vi.fn(),
      language: mocks.language,
      setLanguage: vi.fn(),
      cloudUIStrings: undefined,
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {},
    };
    return selector ? selector(state) : state;
  }, { getState: () => ({ language: mocks.language }) }),
}));

const CHILD_ID = 'subagent-bg-785a227a-9031-480d-9b23-5a520900d459';
const TASK_TEXT = '对比两份报价单中同类物料的单价，找出差异并给出结论。\n\n输入文件：供应商甲报价.csv、供应商乙报价.xlsx';

/** Shape persisted by the real run (db-2.json): the stored receipt is frozen at "running". */
function backgroundSpawn(): ToolCall {
  return {
    id: 'spawn-bg-1',
    name: 'spawn_agent',
    arguments: { customPrompt: '你是数据分析师', run_in_background: true, task: TASK_TEXT },
    result: {
      toolCallId: 'spawn-bg-1',
      success: true,
      output: `已在后台开始处理「对比两份报价单中同类物料的单价，找出差异并给出结论。 输入…」，做完后结果会自动回到这个对话，你可以继续做别的事。\n- Agent ID: ${CHILD_ID}`,
      metadata: { tool: 'spawn_agent', action: 'spawn', status: 'running', agentId: CHILD_ID, result: { background: true } },
    },
  };
}

function node(overrides: Partial<AgentTreeNode> = {}): AgentTreeNode {
  return {
    id: CHILD_ID,
    role: 'dynamic',
    status: 'failed',
    statusLabel: '遇到问题',
    background: true,
    task: TASK_TEXT,
    children: [],
    worktreeState: { status: 'none' },
    budgetSummary: {},
    evidenceRefs: [],
    sources: ['spawnGuard'],
    ...overrides,
  };
}

function withNodes(...nodes: AgentTreeNode[]): AgentTreeSnapshot {
  return {
    generatedAt: 1,
    roots: nodes,
    nodes,
    summary: { total: nodes.length, running: 0, completed: 0, failed: nodes.length, cancelled: 0, blocked: 0, withWorktree: 0, ownershipConflicts: [] },
  };
}

function renderRow() {
  return render(<ToolCallDisplay toolCall={backgroundSpawn()} index={0} total={1} />);
}

beforeEach(() => {
  mocks.tasks = [];
  mocks.snapshot = null;
  mocks.language = 'zh';
  mocks.currentSessionId = 'session-1';
  mocks.running = new Set();
  mocks.messages = [];
  mocks.sendPrompt.mockReset();
  mocks.sendPrompt.mockImplementation(async () => undefined);
  useMemberViewStore.getState().setViewingMemberId(null);
});
afterEach(cleanup);

describe.each([['zh', '已完成', '代理工作中'], ['en', 'Completed', 'Agent working']] as const)(
  'failed background spawn receipt (%s)',
  (language, completedWord, workingWord) => {
    beforeEach(() => { mocks.language = language; });

    it('an unknown child (tree not loaded / node gone) claims neither completed nor working, and offers no exits', () => {
      mocks.snapshot = null;
      const view = renderRow();
      const text = view.container.textContent ?? '';
      expect(text).not.toContain(completedWord);
      expect(text).not.toContain(workingWord);
      expect(text).not.toContain('Done');
      expect(view.queryByTestId('delegation-headline')).toBeNull();
      expect(view.queryByTestId('delegation-failed-actions')).toBeNull();

      mocks.snapshot = withNodes(node({ id: 'someone-else' }));
      view.rerender(<ToolCallDisplay toolCall={backgroundSpawn()} index={0} total={1} />);
      expect(view.container.textContent ?? '').not.toContain(workingWord);
      expect(view.queryByTestId('delegation-failed-actions')).toBeNull();
    });

    it('a failed child turns the same row to failed with the reason and both exits', () => {
      mocks.snapshot = withNodes(node({ failureCode: AgentFailureCode.ModelError, failureReason: '模型调用没有成功完成' }));
      const view = renderRow();
      expect(view.getByTestId('delegation-headline')).toBeTruthy();
      expect(view.getByTestId('delegation-failure').textContent?.length).toBeGreaterThan(0);
      const text = view.container.textContent ?? '';
      expect(text).not.toContain(completedWord);
      expect(text).not.toContain(workingWord);
      expect(view.getByTestId('delegation-view-details')).toBeTruthy();
      expect(view.getByTestId('delegation-retry')).toBeTruthy();
    });

    it('Retry sends the redo sentence once as a user message; a second click sends nothing; View details opens the member view', () => {
      mocks.snapshot = withNodes(node({ failureCode: AgentFailureCode.ModelError }));
      const view = renderRow();
      fireEvent.click(view.getByTestId('delegation-retry'));
      expect(mocks.sendPrompt).toHaveBeenCalledTimes(1);
      const [sentence, context] = mocks.sendPrompt.mock.calls[0] as unknown as [string, { clientMessageId: string }];
      const expected = language === 'zh'
        ? '请重新做一下刚才失败的任务：对比两份报价单中同类物料的单价，找出差异并给出结论。'
        : 'Please redo the task that just failed: 对比两份报价单中同类物料的单价，找出差异并给出结论。';
      expect(sentence).toBe(expected);
      expect(context.clientMessageId).toContain(CHILD_ID);
      expect(context.clientMessageId).toMatch(new RegExp(`^delegation-retry-${CHILD_ID}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, 'i'));
      expect(context.clientMessageId).not.toBe(`delegation-retry-${CHILD_ID}`);
      expect(sentence).not.toContain('输入文件');
      expect((view.getByTestId('delegation-retry') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(view.getByTestId('delegation-retry'));
      expect(mocks.sendPrompt).toHaveBeenCalledTimes(1);
      expect(useMemberViewStore.getState().viewingMemberId).toBeNull();

      fireEvent.click(view.getByTestId('delegation-view-details'));
      expect(useMemberViewStore.getState().viewingMemberId).toBe(CHILD_ID);
    });

    it('Retry is disabled with a plain hint and sends nothing while the session is running', () => {
      mocks.snapshot = withNodes(node({ failureCode: AgentFailureCode.ModelError }));
      mocks.running = new Set(['session-1']);
      const view = renderRow();
      const retry = view.getByTestId('delegation-retry') as HTMLButtonElement;
      expect(retry.disabled).toBe(true);
      expect(retry.title).toBe(language === 'zh' ? '请等当前任务完成后再重试' : 'Wait for the current task to finish');
      fireEvent.click(retry);
      expect(mocks.sendPrompt).not.toHaveBeenCalled();
    });

    it('Retry is disabled and sends nothing when the failed task belongs to another session', () => {
      mocks.tasks = [{
        id: 'task-other', sessionId: 'session-other', toolCallId: 'delegate-1', source: 'delegate_task',
        title: '整理报价单', status: 'failed', createdAt: 1, updatedAt: 2, events: [], outputRefs: [],
      } as unknown as Task];
      const call: ToolCall = {
        id: 'delegate-1', name: 'delegate_task', arguments: { task: '整理报价单' },
        result: { toolCallId: 'delegate-1', success: true, output: '', metadata: { sessionTask: { tasks: [{ taskId: 'task-other' }] } } },
      };
      const view = render(<ToolCallDisplay toolCall={call} index={0} total={1} />);
      const retry = view.getByTestId('delegation-retry') as HTMLButtonElement;
      expect(retry.disabled).toBe(true);
      fireEvent.click(retry);
      expect(mocks.sendPrompt).not.toHaveBeenCalled();
    });

    it('a blank task text never produces an empty redo sentence: the sent text carries the receipt label instead', () => {
      mocks.snapshot = withNodes(node({ failureCode: AgentFailureCode.ModelError, task: '   ' }));
      const call = backgroundSpawn();
      call.arguments = { ...call.arguments, task: '   ' };
      const view = render(<ToolCallDisplay toolCall={call} index={0} total={1} />);
      fireEvent.click(view.getByTestId('delegation-retry'));
      expect(mocks.sendPrompt).toHaveBeenCalledTimes(1);
      const [sentence] = mocks.sendPrompt.mock.calls[0] as unknown as [string];
      expect(sentence).not.toContain('{task}');
      expect(sentence.trim().length).toBeGreaterThan(language === 'zh' ? '请重新做一下刚才失败的任务：'.length : 'Please redo the task that just failed:'.length);
    });

    it('after a restart (failure code lost) the reason is never the raw tool dump', () => {
      mocks.snapshot = withNodes(node({
        role: 'user',
        progress: 'Tool results:\nTool Glob: Success\n供应商乙报价.xlsx\n\nnextOffset: null',
      }));
      const view = renderRow();
      const failure = view.getByTestId('delegation-failure').textContent ?? '';
      expect(failure.length).toBeGreaterThan(0);
      expect(failure).not.toContain('Tool results');
      expect(failure).not.toContain('nextOffset');
    });

    it('working and completed children show no failure exits', () => {
      mocks.snapshot = withNodes(node({ status: 'running' }));
      const view = renderRow();
      expect(view.queryByTestId('delegation-failed-actions')).toBeNull();
      mocks.snapshot = withNodes(node({ status: 'completed' }));
      view.rerender(<ToolCallDisplay toolCall={backgroundSpawn()} index={0} total={1} />);
      expect(view.queryByTestId('delegation-failed-actions')).toBeNull();
    });
  },
);

const RETRY_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function failedCard(memberId: string, endedAt?: number): DelegationPresentation {
  return {
    state: 'failed',
    title: '对比两份报价单',
    outputs: [],
    activityIds: [memberId],
    memberId,
    retryTitle: '对比两份报价单中同类物料的单价',
    failure: '没有找到报价文件',
    ...(endedAt === undefined ? {} : { endedAt }),
  };
}

function sentClientMessageId(callIndex: number): string {
  const call = mocks.sendPrompt.mock.calls[callIndex] as unknown as [string, { clientMessageId: string }];
  return call[1].clientMessageId;
}

describe('delegation retry id and persisted sent state', () => {
  it('click Retry, unmount, remount: the same failed card stays disabled', () => {
    mocks.sendPrompt.mockImplementation(async (_sentence: string, context?: { clientMessageId?: string }) => {
      // The real chat sender persists this user row before the next paint of a remount.
      mocks.messages.push({
        id: context?.clientMessageId ?? 'missing',
        role: 'user',
        content: '请重新做一下刚才失败的任务：对比两份报价单中同类物料的单价',
        timestamp: 5_000,
      });
      return undefined;
    });
    const presentation = failedCard('task-quote');
    const first = render(<DelegationReceipt presentation={presentation} />);
    expect((first.getByTestId('delegation-retry') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(first.getByTestId('delegation-retry'));
    expect(mocks.sendPrompt).toHaveBeenCalledTimes(1);
    expect(sentClientMessageId(0)).toMatch(new RegExp(`^delegation-retry-task-quote-${RETRY_UUID}$`, 'i'));
    first.unmount();

    const second = render(<DelegationReceipt presentation={presentation} />);
    const retry = second.getByTestId('delegation-retry') as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    expect(mocks.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('two valid clicks on different failed cards send different clientMessageIds', () => {
    const first = render(<DelegationReceipt presentation={failedCard('task-a', 1_000)} />);
    fireEvent.click(first.getByTestId('delegation-retry'));
    first.unmount();
    const second = render(<DelegationReceipt presentation={failedCard('task-b', 1_000)} />);
    fireEvent.click(second.getByTestId('delegation-retry'));
    const left = sentClientMessageId(0);
    const right = sentClientMessageId(1);
    expect(left).toMatch(new RegExp(`^delegation-retry-task-a-${RETRY_UUID}$`, 'i'));
    expect(right).toMatch(new RegExp(`^delegation-retry-task-b-${RETRY_UUID}$`, 'i'));
    expect(left).not.toBe(right);
  });

  it('a failure newer than the stored retry enables Retry again and sends a new id', () => {
    const storedId = 'delegation-retry-task-quote-11111111-1111-4111-8111-111111111111';
    mocks.messages.push({
      id: storedId,
      role: 'user',
      content: '请重新做一下刚才失败的任务：对比两份报价单中同类物料的单价',
      timestamp: 2_000,
    });
    const view = render(<DelegationReceipt presentation={failedCard('task-quote', 1_000)} />);
    expect((view.getByTestId('delegation-retry') as HTMLButtonElement).disabled).toBe(true);

    view.rerender(<DelegationReceipt presentation={failedCard('task-quote', 2_000)} />);
    expect((view.getByTestId('delegation-retry') as HTMLButtonElement).disabled).toBe(false);

    view.rerender(<DelegationReceipt presentation={failedCard('task-quote', 3_000)} />);
    const retry = view.getByTestId('delegation-retry') as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    const sentId = sentClientMessageId(0);
    expect(sentId).toMatch(new RegExp(`^delegation-retry-task-quote-${RETRY_UUID}$`, 'i'));
    expect(sentId).not.toBe(storedId);
  });

  it('an assistant row, an older retry, or another card does not lock this failure', () => {
    mocks.messages.push(
      { id: 'delegation-retry-task-quote-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'assistant', content: 'not a user retry', timestamp: 9_000 },
      { id: 'delegation-retry-task-quote-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'user', content: 'older retry', timestamp: 500 },
      { id: 'delegation-retry-other-card-cccccccc-cccc-4ccc-8ccc-cccccccccccc', role: 'user', content: 'other card', timestamp: 9_000 },
    );
    const view = render(<DelegationReceipt presentation={failedCard('task-quote', 1_000)} />);
    expect((view.getByTestId('delegation-retry') as HTMLButtonElement).disabled).toBe(false);
  });
});
