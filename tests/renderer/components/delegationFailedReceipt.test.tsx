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
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';

const mocks = vi.hoisted(() => ({
  tasks: [] as Task[],
  snapshot: null as AgentTreeSnapshot | null,
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: Task[] }) => unknown) => selector({ tasks: mocks.tasks }),
}));
vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: mocks.snapshot, refresh: vi.fn() }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 'session-1' }),
    { getState: () => ({ currentSessionId: 'session-1', switchSession: vi.fn() }) },
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

    it('Retry only fills the composer with the task title; View details opens the member view', () => {
      mocks.snapshot = withNodes(node({ failureCode: AgentFailureCode.ModelError }));
      const drafts: string[] = [];
      const onDraft = (event: Event) => drafts.push((event as CustomEvent<string>).detail);
      window.addEventListener('iact:add', onDraft);
      try {
        const view = renderRow();
        fireEvent.click(view.getByTestId('delegation-retry'));
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toContain('对比两份报价单中同类物料的单价，找出差异并给出结论。');
        expect(drafts[0]).not.toContain('输入文件');
        expect(useMemberViewStore.getState().viewingMemberId).toBeNull();

        fireEvent.click(view.getByTestId('delegation-view-details'));
        expect(useMemberViewStore.getState().viewingMemberId).toBe(CHILD_ID);
      } finally {
        window.removeEventListener('iact:add', onDraft);
      }
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
