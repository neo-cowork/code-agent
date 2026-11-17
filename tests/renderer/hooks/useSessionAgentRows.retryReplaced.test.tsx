// @vitest-environment jsdom
// ============================================================================
// 失败后台任务被同会话「之后成功」的重试取代：行与折叠成员条都不再残留失败
// （N-FIX-RUN-FAIL-AGENT-CHIP-STALE-FU1-FU1-RETRYMARK-FIX）
// 夹具形状取自真跑：X 重启后重建只带 shortName+childRunId，Y 只带 shortName+laneKey。
// 真 backgroundTaskStore + 真 useSessionAgentRows；成员条测试渲染真 SessionMemberBar。
// ============================================================================
import React from 'react';
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTreeSnapshot } from '@shared/contract/agentTree';
import type { Task } from '@shared/contract/backgroundTask';
import { zh } from '../../../src/renderer/i18n/zh';

const runtime = vi.hoisted(() => ({ snapshot: null as unknown }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: runtime.snapshot, refresh: async () => {} }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn().mockResolvedValue([]), invokeDomain: vi.fn().mockResolvedValue(null) },
}));

import { useSessionAgentRows } from '../../../src/renderer/hooks/useSessionAgentRows';
import { SessionMemberBar } from '../../../src/renderer/components/features/expert/SessionMemberBar';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';

const SESSION = 'session-1';
const NAME = '运营报告';

function task(id: string, status: Task['status'], at: number, metadata: Task['metadata'], extra: Partial<Task> = {}): Task {
  return {
    id, sessionId: SESSION, source: 'session_command_center', title: NAME, status,
    createdAt: at - 10, updatedAt: at, completedAt: at, events: [], outputRefs: [], metadata, ...extra,
  };
}

const failedX = (metadata: Task['metadata'] = { shortName: NAME, childRunId: 'child-x' }) => task('task-x', 'failed', 100, metadata, {
  failure: { reason: 'session_command_task_interrupted_by_restart', message: '任务因应用重启而中断。' },
});
const doneY = (metadata: Task['metadata'] = { shortName: NAME, laneKey: 'operations-report' }, at = 200) => task('task-y', 'completed', at, metadata);

function rowsFor(tasks: Task[]) {
  useBackgroundTaskStore.getState().setTasks(tasks);
  return renderHook(() => useSessionAgentRows(SESSION)).result.current.rows;
}

describe('useSessionAgentRows drops failed tasks replaced by a later success', () => {
  beforeEach(() => {
    runtime.snapshot = null;
    useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [], isLoaded: true });
  });
  afterEach(() => {
    cleanup();
    useBackgroundTaskStore.getState().setTasks([]);
  });

  it('(i) measured shape: failed X + later completed Y with same shortName -> X row gone, collapsed bar has no failed text', async () => {
    const rows = rowsFor([failedX(), doneY()]);
    expect(rows.map((row) => `${row.key}:${row.status}`)).toEqual(['task-y:done']);

    render(<SessionMemberBar sessionId={SESSION} />);
    const chip = await screen.findByTestId('session-member-bar-collapsed');
    expect(chip.textContent).not.toMatch(/失败|Failed/);
    expect(chip.getAttribute('title') ?? '').not.toMatch(/失败|Failed/);
  });

  it('(ii) failed task with no later success stays a failed row', async () => {
    const rows = rowsFor([failedX()]);
    expect(rows.map((row) => `${row.key}:${row.status}`)).toEqual(['task-x:failed']);

    render(<SessionMemberBar sessionId={SESSION} />);
    const chip = await screen.findByTestId('session-member-bar-collapsed');
    expect(chip.textContent).toContain('失败');
  });

  it('(iii) an EARLIER completed task with the same shortName does not replace the failed one', () => {
    const rows = rowsFor([failedX(), doneY({ shortName: NAME }, 50)]);
    expect(rows.find((row) => row.key === 'task-x')?.status).toBe('failed');
  });

  it('(iv) a later completed task with a DIFFERENT shortName does not replace the failed one', () => {
    const rows = rowsFor([failedX(), doneY({ shortName: '另一个任务', laneKey: 'other' })]);
    expect(rows.find((row) => row.key === 'task-x')?.status).toBe('failed');
  });

  it('(v) explicit retryOf link replaces even with different shortNames and earlier timestamps', () => {
    const rows = rowsFor([
      failedX({ shortName: '旧名字' }),
      doneY({ shortName: '新名字', retryOf: { taskId: 'task-x', status: 'failed', detail: 'x' } }, 50),
    ]);
    expect(rows.map((row) => row.key)).toEqual(['task-y']);
  });

  it('(b) same laneKey with different shortName replaces', () => {
    const rows = rowsFor([failedX({ shortName: 'A', laneKey: 'lane-1' }), doneY({ shortName: 'B', laneKey: 'lane-1' })]);
    expect(rows.map((row) => row.key)).toEqual(['task-y']);
  });

  it('(vi) X also present as an agentTree node (linked by childRunId) is dropped too', () => {
    runtime.snapshot = {
      generatedAt: 300, sessionId: SESSION, roots: [], summary: { total: 1, running: 0, completed: 0, failed: 1, cancelled: 0, blocked: 0, withWorktree: 0, totalTokensUsed: 0, ownershipConflicts: [] },
      nodes: [{
        id: 'child-x', role: 'coder', status: 'failed', statusLabel: '失败', children: [], worktreeState: { status: 'none' },
        budgetSummary: { tokensUsed: 0, maxTokens: 1000, usagePercent: 0 }, evidenceRefs: [], sources: ['subagentContext'], displayName: 'Coder',
      }],
    } as unknown as AgentTreeSnapshot;
    const without = rowsFor([failedX()]);
    expect(without.map((row) => row.key)).toEqual(['child-x']);
    cleanup();
    const rows = rowsFor([failedX(), doneY()]);
    expect(rows.map((row) => row.key)).toEqual(['task-y']);
  });
});
