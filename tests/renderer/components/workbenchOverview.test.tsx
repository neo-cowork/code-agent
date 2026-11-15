// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchOverview } from '../../../src/renderer/components/WorkbenchOverview';
import { deriveHasTaskActivity } from '../../../src/renderer/hooks/useTaskActivity';
import { buildRunUiState } from '../../../src/renderer/utils/runWorkbenchProjection';

const taskActivity = vi.hoisted(() => ({
  hasTaskActivity: false,
  agentTreeSnapshot: null,
}));

// 当前会话的 workbenchSnapshot 决定空态挂不挂「最近产物」预览
const sessionState = vi.hoisted(() => ({
  currentSessionId: null as string | null,
  sessions: [] as Array<{ id: string; workbenchSnapshot?: { summary: string } }>,
}));

// 会话已有产物（跑完的任务/重开的会话）时不进叙事空态，产物区继续展示
const previewItems = vi.hoisted(() => ({
  items: [] as Array<{ id: string }>,
}));
const appState = vi.hoisted(() => ({
  language: 'zh' as const,
  setLanguage: vi.fn(),
  cloudUIStrings: null,
}));

vi.mock('../../../src/renderer/hooks/useTaskActivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/hooks/useTaskActivity')>();
  return {
    ...actual,
    useTaskActivity: () => taskActivity,
  };
});
vi.mock('../../../src/renderer/hooks/useWorkspacePreviewModel', () => ({
  useWorkspacePreviewModel: () => previewItems.items,
  // 角色轴（ADR-055）：概览改用 …State 取 { items, materialItems }；替身要跟上新导出
  useWorkspacePreviewModelState: () => ({ items: previewItems.items, materialItems: [], receiptItems: [], currentTurnArtifacts: null }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => (
    selector ? selector(appState) : appState
  ),
}));
vi.mock('../../../src/renderer/components/TaskPanel', () => ({
  // N-LEDGER-P1 新合同：空态叙事由 WorkbenchOverview 组装、经 overviewContent
  // 注入 TaskPanel 的「概览」tab；替身按同一合同渲染，断言内容仍全部来自被测组件。
  TaskPanel: ({ overviewContent }: { overviewContent?: React.ReactNode }) => (
    overviewContent ?? <div data-testid="task-progress-marker">task progress</div>
  ),
}));
vi.mock('../../../src/renderer/components/WorkspacePreviewPanel', () => ({
  WorkspacePreviewPanel: () => <div data-testid="artifact-marker">artifacts</div>,
}));

afterEach(() => cleanup());

describe('WorkbenchOverview', () => {
  beforeEach(() => {
    taskActivity.hasTaskActivity = false;
    taskActivity.agentTreeSnapshot = null;
    sessionState.currentSessionId = null;
    sessionState.sessions = [];
    previewItems.items = [];
  });

  it('shows the task-scene narrative instead of an empty artifact shell when there is no task activity', () => {
    render(<WorkbenchOverview />);

    expect(screen.queryByTestId('workbench-overview-workspace')).toBeNull();
    expect(screen.queryByTestId('task-progress-marker')).toBeNull();
    // 空态是叙事（运行中的任务会实时显示在这里），不再是产物区自己的空壳
    expect(screen.getByTestId('workbench-overview-empty')).toBeTruthy();
    expect(screen.queryByTestId('artifact-marker')).toBeNull();
    // 没有会话快照时不挂「最近产物」预览
    expect(screen.queryByTestId('workbench-overview-recent')).toBeNull();
  });

  it('previews the latest workbench snapshot summary in the empty state', () => {
    sessionState.currentSessionId = 'session-1';
    sessionState.sessions = [
      { id: 'session-1', workbenchSnapshot: { summary: '工作区 · 3 个文件' } },
    ];
    render(<WorkbenchOverview />);

    const recent = screen.getByTestId('workbench-overview-recent');
    expect(recent.textContent).toContain('工作区 · 3 个文件');
    expect(recent.className).toContain('items-center');
    expect(recent.className).toContain('text-center');
  });

  it('does not treat a plain-chat snapshot as a deliverable scene', () => {
    sessionState.currentSessionId = 'session-1';
    sessionState.sessions = [
      { id: 'session-1', workbenchSnapshot: { summary: '纯对话' } },
    ];
    render(<WorkbenchOverview />);

    expect(screen.getByTestId('workbench-overview-empty')).toBeTruthy();
    expect(screen.queryByTestId('workbench-overview-recent')).toBeNull();
  });

  it('keeps the task workspace when the session has artifacts but no live task activity', () => {
    previewItems.items = [{ id: 'artifact-1' }];
    render(<WorkbenchOverview />);

    // 跑完的任务/重开的会话：Todo/上下文/产物仍由同一工作台承载。
    expect(screen.queryByTestId('workbench-overview-empty')).toBeNull();
    expect(screen.getByTestId('workbench-overview-workspace')).toBeTruthy();
    expect(screen.getByTestId('task-progress-marker')).toBeTruthy();
    expect(screen.queryByTestId('artifact-marker')).toBeNull();
  });

  it('renders one complete task workspace when any task activity exists', () => {
    taskActivity.hasTaskActivity = true;
    render(<WorkbenchOverview />);

    expect(screen.getByTestId('workbench-overview-workspace')).toBeTruthy();
    expect(screen.getByTestId('task-progress-marker')).toBeTruthy();
    expect(screen.queryByTestId('artifact-marker')).toBeNull();
    expect(screen.queryByTestId('workbench-overview-empty')).toBeNull();
  });

  it('never replaces overview with the retired focused artifact intermediate page', () => {
    previewItems.items = [{ id: 'artifact-1' }];
    render(<WorkbenchOverview />);

    expect(screen.getByTestId('workbench-overview-workspace')).toBeTruthy();
    expect(screen.queryByTestId('workbench-overview-preview')).toBeNull();
    expect(screen.queryByTestId('artifact-marker')).toBeNull();
  });

  it('recognizes agent trees, tasks, stored progress, and live runs as activity', () => {
    const quiet = {
      agentNodeCount: 0,
      taskCount: 0,
      taskProgress: null,
      runStatus: 'completed' as const,
      hasRunPresence: false,
    };

    expect(deriveHasTaskActivity(quiet)).toBe(false);
    expect(deriveHasTaskActivity({ ...quiet, agentNodeCount: 1 })).toBe(true);
    expect(deriveHasTaskActivity({ ...quiet, taskCount: 1 })).toBe(true);
    expect(deriveHasTaskActivity({
      ...quiet,
      taskProgress: { turnId: 'turn-1', phase: 'tool_running', progress: 50 },
    })).toBe(true);
    expect(deriveHasTaskActivity({ ...quiet, runStatus: 'using_tools', hasRunPresence: true })).toBe(true);
  });

  it('does not treat a live run status without run presence as activity', () => {
    const synthetic = {
      agentNodeCount: 0,
      taskCount: 0,
      taskProgress: null,
      runStatus: 'planning' as const,
      hasRunPresence: false,
    };

    // 空会话的合成 planning（无 turn、无在途会话）不挤掉空态叙事
    expect(deriveHasTaskActivity(synthetic)).toBe(false);
    expect(deriveHasTaskActivity({ ...synthetic, runStatus: 'running' })).toBe(false);
    // 有 turn 落投影（或会话在途）的 live 状态才是活动
    expect(deriveHasTaskActivity({ ...synthetic, hasRunPresence: true })).toBe(true);
  });

  it('preserves the idle empty-session narrative across projection and activity consumers', () => {
    // 组合层钉子：空会话投影出非终止状态（不伪造 completed），
    // activity 消费侧凭存在证据把它判为「没有活动」，空态叙事得以保留。
    const idleRun = buildRunUiState({
      projection: { sessionId: 'session-new', turns: [], activeTurnIndex: -1 },
      sessionId: 'session-new',
      sessionStatus: 'idle',
    });
    expect(idleRun.status).toBe('planning');
    expect(idleRun.identity.turnId).toBeNull();
    expect(deriveHasTaskActivity({
      agentNodeCount: 0,
      taskCount: 0,
      taskProgress: null,
      runStatus: idleRun.status,
      hasRunPresence: idleRun.identity.turnId !== null,
    })).toBe(false);

    // Send 已受理（会话侧 running/queued）但 turn 尚未落投影：在途窗口仍是活动
    for (const sessionStatus of ['queued', 'running'] as const) {
      const inFlightRun = buildRunUiState({
        projection: { sessionId: 'session-new', turns: [], activeTurnIndex: -1 },
        sessionId: 'session-new',
        sessionStatus,
      });
      expect(inFlightRun.identity.turnId).toBeNull();
      expect(deriveHasTaskActivity({
        agentNodeCount: 0,
        taskCount: 0,
        taskProgress: null,
        runStatus: inFlightRun.status,
        hasRunPresence: inFlightRun.identity.turnId !== null || sessionStatus === 'running' || sessionStatus === 'queued',
      })).toBe(true);
    }
  });
});
