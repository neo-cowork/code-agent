// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import { getSystemPromptHint } from '../../../src/shared/i18n/sessionTaskSlot';
import { DelegationReceipt } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/DelegationReceipt';
import type { DelegationPresentation } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';
import type { StopSessionAgentResult } from '../../../src/renderer/utils/stopSessionAgent';

const mocks = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  tasks: [] as Task[],
  refreshTasks: vi.fn<() => Promise<void>>(),
  stopSessionAgent: vi.fn<() => Promise<StopSessionAgentResult>>(),
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => {
  const getState = () => ({
    tasks: mocks.tasks,
    refreshTasks: mocks.refreshTasks,
  });
  const useBackgroundTaskStore = Object.assign(
    (selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()),
    { getState },
  );
  return { useBackgroundTaskStore };
});

vi.mock('../../../src/renderer/utils/stopSessionAgent', () => ({
  stopSessionAgent: (...args: unknown[]) => mocks.stopSessionAgent(...(args as [])),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { sessions: []; hasOlderSessions: boolean }) => unknown) => (
    selector({ sessions: [], hasOlderSessions: false })
  ),
}));

vi.mock('../../../src/renderer/stores/sessionListPagination', () => ({
  useSessionListLoadStore: (selector: (state: { settled: boolean }) => unknown) => selector({ settled: true }),
}));

vi.mock('../../../src/renderer/stores/memberViewStore', () => ({
  useMemberViewStore: { getState: () => ({ setViewingMemberId: vi.fn() }) },
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector?: (state: {
      openPreview: ReturnType<typeof vi.fn>;
      language: 'zh' | 'en';
      setLanguage: ReturnType<typeof vi.fn>;
      cloudUIStrings: undefined;
      pendingPermissionRequest: null;
      pendingPermissionSessionId: null;
      queuedPermissionRequests: Record<string, never>;
    }) => unknown) => {
      const state = {
        openPreview: vi.fn(),
        language: mocks.language,
        setLanguage: vi.fn(),
        cloudUIStrings: undefined,
        pendingPermissionRequest: null,
        pendingPermissionSessionId: null,
        queuedPermissionRequests: {},
      };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ language: mocks.language }) },
  ),
}));

function makeShellTask(overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: 'shell:task-preview-1',
    kind: 'shell',
    source: 'shell',
    sessionId: 'session-1',
    title: '本地预览服务',
    command: 'python3 -m http.server 8765',
    status: 'running',
    createdAt: now - 120_000,
    startedAt: now - 120_000,
    updatedAt: now,
    events: [],
    outputRefs: [],
    metadata: {
      originalTaskId: 'task-preview-1',
      ownerAgentId: 'agent_coder_123',
    },
    ...overrides,
  };
}

function makePresentation(overrides: Partial<DelegationPresentation> = {}): DelegationPresentation {
  return {
    state: 'completed',
    title: '启动笔记预览服务',
    outputs: [],
    activityIds: ['agent_coder_123'],
    memberId: 'agent_coder_123',
    sessionId: 'session-1',
    ...overrides,
  };
}

describe('DelegationLeftoverShells via DelegationReceipt', () => {
  beforeEach(() => {
    mocks.language = 'zh';
    mocks.tasks = [];
    mocks.refreshTasks.mockReset().mockResolvedValue(undefined);
    mocks.stopSessionAgent.mockReset().mockResolvedValue('stopped');
  });

  afterEach(() => {
    cleanup();
  });

  it('shows running leftover shells for the card owner, stops on click, refreshes store, and flips to stopped (zh & en)', async () => {
    mocks.tasks = [
      makeShellTask(),
      makeShellTask({
        id: 'shell:task-other-agent',
        title: '别的代理命令',
        metadata: { originalTaskId: 'task-other-agent', ownerAgentId: 'agent_other_999' },
      }),
      makeShellTask({
        id: 'shell:task-main-session',
        title: '主会话命令',
        metadata: { originalTaskId: 'task-main-session' },
      }),
    ];
    mocks.stopSessionAgent.mockImplementation(async () => {
      mocks.tasks = mocks.tasks.map((task) => (
        task.id === 'shell:task-preview-1' ? { ...task, status: 'cancelled' } : task
      ));
      return 'stopped';
    });

    const view = render(<DelegationReceipt presentation={makePresentation()} />);

    const rows = view.getAllByTestId('delegation-leftover-shell-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('仍在运行：本地预览服务');
    expect(rows[0].textContent).toContain('已运行 2 分钟');
    expect(rows[0].textContent).not.toContain('task-preview-1');
    expect(rows[0].textContent).not.toContain('http.server');
    expect(view.queryByText(/别的代理命令/)).toBeNull();
    expect(view.queryByText(/主会话命令/)).toBeNull();

    const stopButton = view.getByTestId('delegation-leftover-shell-stop');
    expect(stopButton.textContent).toBe('停止');
    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(mocks.stopSessionAgent).toHaveBeenCalledWith(
        { kind: 'task', key: 'shell:task-preview-1' },
        'session-1',
      );
      expect(mocks.refreshTasks).toHaveBeenCalledTimes(1);
      expect(view.getByTestId('delegation-leftover-shell-stopped').textContent).toContain('已停止');
    });
    expect(view.queryByTestId('delegation-leftover-shell-stop')).toBeNull();

    // Verify English locale copy on stopped state too
    mocks.language = 'en';
    mocks.tasks = [
      makeShellTask({
        title: 'Local preview server',
        status: 'cancelled',
      }),
    ];
    view.rerender(<DelegationReceipt presentation={makePresentation()} />);
    expect(view.getByTestId('delegation-leftover-shell-stopped').textContent).toContain('Stopped');
  });

  it('shows exact system-prompt hint sentence when mayAwaitSystemPrompt is set (running and after stop, zh & en)', async () => {
    mocks.language = 'en';
    mocks.tasks = [
      makeShellTask({
        id: 'shell:task-osa-1',
        title: 'Check Finder selection',
        metadata: {
          originalTaskId: 'task-osa-1',
          ownerAgentId: 'agent_coder_123',
          mayAwaitSystemPrompt: true,
        },
      }),
    ];
    mocks.stopSessionAgent.mockImplementation(async () => {
      mocks.tasks = [{ ...mocks.tasks[0], status: 'cancelled' }];
      return 'stopped';
    });

    const view = render(<DelegationReceipt presentation={makePresentation()} />);
    expect(view.getByTestId('delegation-leftover-shell-row').textContent).toContain('Still running: Check Finder selection');
    expect(view.getByTestId('delegation-leftover-shell-stop').textContent).toBe('Stop');
    expect(view.getByTestId('delegation-leftover-shell-prompt-hint').textContent).toBe(getSystemPromptHint('en'));

    fireEvent.click(view.getByTestId('delegation-leftover-shell-stop'));
    await waitFor(() => {
      expect(view.getByTestId('delegation-leftover-shell-stopped').textContent).toContain('Stopped');
    });
    expect(view.getByTestId('delegation-leftover-shell-prompt-hint').textContent).toBe(getSystemPromptHint('en'));

    mocks.language = 'zh';
    view.rerender(<DelegationReceipt presentation={makePresentation()} />);
    expect(view.getByTestId('delegation-leftover-shell-prompt-hint').textContent).toBe(getSystemPromptHint('zh'));
  });

  it('shows plain-language error note and restores the Stop button on stop failure, then allows retry', async () => {
    mocks.tasks = [makeShellTask()];
    mocks.stopSessionAgent.mockResolvedValueOnce('error');

    const view = render(<DelegationReceipt presentation={makePresentation()} />);
    fireEvent.click(view.getByTestId('delegation-leftover-shell-stop'));

    await waitFor(() => {
      expect(view.getByTestId('delegation-leftover-shell-error').textContent).toBe('未能停止，请稍后重试。');
    });
    expect(view.getByTestId('delegation-leftover-shell-stop')).toBeDefined();

    // Retry succeeds
    mocks.stopSessionAgent.mockResolvedValueOnce('stopped');
    fireEvent.click(view.getByTestId('delegation-leftover-shell-stop'));
    await waitFor(() => {
      expect(view.getByTestId('delegation-leftover-shell-stopped').textContent).toContain('已停止');
    });
    expect(view.queryByTestId('delegation-leftover-shell-error')).toBeNull();
  });

  it('removes the row when the shell exits by itself without clicking Stop, and does not mount on working cards', () => {
    mocks.tasks = [makeShellTask()];
    const view = render(<DelegationReceipt presentation={makePresentation({ state: 'working' })} />);
    expect(view.queryByTestId('delegation-leftover-shells')).toBeNull();

    view.rerender(<DelegationReceipt presentation={makePresentation({ state: 'completed' })} />);
    expect(view.getAllByTestId('delegation-leftover-shell-row')).toHaveLength(1);

    mocks.tasks = [makeShellTask({ status: 'completed' })];
    view.rerender(<DelegationReceipt presentation={makePresentation({ state: 'completed' })} />);
    expect(view.queryByTestId('delegation-leftover-shells')).toBeNull();
  });
});
