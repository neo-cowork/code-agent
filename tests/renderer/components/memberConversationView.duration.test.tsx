// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { SwarmAgentState } from '../../../src/shared/contract/swarm';
import type { SwarmRunAgentRecord, SwarmRunDetail, SwarmRunListItem } from '../../../src/shared/contract/swarmTrace';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

let translations: typeof zh = zh;
const invokeMock = vi.fn();
const invokeDomainMock = vi.fn();
const swarmState: {
  agents: SwarmAgentState[];
  activeSessionId: string | undefined;
  messages: Array<{ id: string; from: string; to: string; content: string; timestamp: number; messageType: string }>;
} = {
  agents: [],
  activeSessionId: undefined,
  messages: [],
};

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: translations }) }));
vi.mock('../../../src/renderer/stores/swarmStore', () => ({
  useSwarmStore: (selector: (state: typeof swarmState) => unknown) => selector(swarmState),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
  },
}));

import { MemberConversationView } from '../../../src/renderer/components/features/expert/MemberConversationView';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function plainTaskOf(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    sessionId: 'session-1',
    source: 'session_command_center',
    title: '整理本周周报',
    summary: '已汇总三页资料',
    status: 'completed',
    createdAt: 1_000,
    updatedAt: 6_000,
    completedAt: 6_000,
    events: [],
    outputRefs: [],
    ...overrides,
  };
}

function setupExpertFixture(overrides: Partial<SwarmRunAgentRecord> = {}, agentOverrides: Partial<SwarmAgentState> = {}) {
  const record: SwarmRunAgentRecord = {
    runId: 'run-1',
    agentId: 'researcher',
    name: '调研员',
    role: 'researcher',
    status: 'completed',
    startTime: 10_000,
    endTime: 75_000,
    durationMs: 65_000,
    tokensIn: 120,
    tokensOut: 240,
    toolCalls: 4,
    costUsd: 0.0042,
    error: null,
    failureCategory: null,
    filesChanged: [],
    dispatchedTask: '核对三页资料并汇总',
    finalOutput: '已完成汇总',
    ...overrides,
  };
  const ledgerRun: SwarmRunListItem = {
    id: 'run-1',
    sessionId: 'session-1',
    status: record.status === 'running' ? 'running' : 'completed',
    coordinator: 'parallel',
    startedAt: 10_000,
    endedAt: record.status === 'running' ? null : 75_000,
    durationMs: record.status === 'running' ? null : 65_000,
    totalAgents: 1,
    completedCount: record.status === 'running' ? 0 : 1,
    failedCount: 0,
    totalCostUsd: 0.0042,
    totalTokensIn: 120,
    totalTokensOut: 240,
    trigger: 'llm-spawn',
  };
  const ledgerDetail: SwarmRunDetail = {
    run: { ...ledgerRun, totalToolCalls: 4, parallelPeak: 1, errorSummary: null, aggregation: null, tags: [] },
    agents: [record],
    events: [],
  };
  invokeMock.mockImplementation((channel: unknown) => {
    if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([ledgerRun]);
    if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) return Promise.resolve(ledgerDetail);
    return Promise.resolve(null);
  });
  swarmState.agents = [
    {
      id: record.agentId,
      name: record.name,
      role: record.role,
      status: record.status === 'running' ? 'running' : 'completed',
      startTime: record.startTime ?? undefined,
      endTime: record.endTime ?? undefined,
      iterations: 0,
      tokenUsage: { input: record.tokensIn, output: record.tokensOut },
      toolCalls: record.toolCalls,
      cost: record.costUsd,
      dispatchedTask: record.dispatchedTask,
      finalOutput: record.finalOutput,
      filesChanged: [],
      ...agentOverrides,
    },
  ];
}

describe('MemberConversationView duration formatting and live updates', () => {
  beforeEach(() => {
    translations = zh;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    invokeDomainMock.mockReset();
    invokeDomainMock.mockResolvedValue(null);
    swarmState.activeSessionId = 'session-1';
    swarmState.agents = [];
    swarmState.messages = [];
    useMemberViewStore.setState({ viewingMemberId: null });
    useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [], isLoaded: true });
    useBackgroundTaskStore.setState({ tasks: [] });
    useAppStore.setState({ pendingPermissionRequest: null, pendingPermissionSessionId: null, queuedPermissionRequests: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  describe.each([
    { lang: 'zh' as const, dict: zh, underOne: '不到 1 秒', s5: '5 秒', s65: '1 分 5 秒', s120: '2 分' },
    { lang: 'en' as const, dict: en, underOne: 'under 1 sec', s5: '5 sec', s65: '1 min 5 sec', s120: '2 min' },
  ])('duration formatter via MemberConversationView ($lang)', ({ dict, underOne, s5, s65, s120 }) => {
    it.each([
      { label: '0ms', task: plainTaskOf({ createdAt: 10_000, completedAt: 10_000, updatedAt: 10_000 }), expected: underOne },
      { label: '500ms', task: plainTaskOf({ createdAt: 10_000, completedAt: 10_500, updatedAt: 10_500 }), expected: underOne },
      { label: '5s', task: plainTaskOf({ durationMs: 5_000 }), expected: s5 },
      { label: '65s', task: plainTaskOf({ durationMs: 65_000 }), expected: s65 },
      { label: '120s drops trailing zero seconds', task: plainTaskOf({ durationMs: 120_000 }), expected: s120 },
    ])('formats $label accurately', async ({ task, expected }) => {
      translations = dict;
      useBackgroundTaskStore.setState({ tasks: [task] });
      useMemberViewStore.setState({ viewingMemberId: task.id });

      render(<MemberConversationView sessionId="session-1" />);
      await waitFor(() => expect(screen.getByTestId('member-usage-duration')).toBeTruthy());
      const duration = screen.getByTestId('member-usage-duration');
      expect(duration.textContent).toBe(expected);
      expect(duration.querySelector('svg')).not.toBeNull();
      expect(screen.getByTestId('member-usage').textContent).not.toContain('—');
    });

    it.each([
      { label: 'null / missing timestamps', task: plainTaskOf({ createdAt: 0, completedAt: undefined, updatedAt: 0, durationMs: undefined }) },
      { label: 'undefined durationMs with NaN timestamps', task: plainTaskOf({ createdAt: Number.NaN, completedAt: undefined, updatedAt: Number.NaN, durationMs: undefined }) },
      { label: 'negative elapsed', task: plainTaskOf({ createdAt: 20_000, completedAt: 10_000, updatedAt: 10_000, durationMs: undefined }) },
    ])('hides clock and text for $label', async ({ task }) => {
      translations = dict;
      useBackgroundTaskStore.setState({ tasks: [task] });
      useMemberViewStore.setState({ viewingMemberId: task.id });

      render(<MemberConversationView sessionId="session-1" />);
      await waitFor(() => expect(screen.getByTestId('member-usage')).toBeTruthy());
      expect(screen.queryByTestId('member-usage-duration')).toBeNull();
      expect(screen.getByTestId('member-usage').querySelector('svg')).toBeNull();
      expect(screen.getByTestId('member-usage').textContent).not.toContain('—');
    });
  });

  it('derives elapsed from createdAt + completedAt for completed and failed plain tasks without durationMs', async () => {
    const completedTask = plainTaskOf({
      id: 'task-completed',
      status: 'completed',
      createdAt: 1_000,
      completedAt: 66_000,
      updatedAt: 66_000,
      durationMs: undefined,
    });
    useBackgroundTaskStore.setState({ tasks: [completedTask] });
    useMemberViewStore.setState({ viewingMemberId: 'task-completed' });

    const { rerender } = render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-usage-duration').textContent).toBe('1 分 5 秒'));

    const failedTask = plainTaskOf({
      id: 'task-failed',
      status: 'failed',
      createdAt: 2_000,
      completedAt: 14_000,
      updatedAt: 14_000,
      durationMs: undefined,
    });
    useBackgroundTaskStore.setState({ tasks: [failedTask] });
    useMemberViewStore.setState({ viewingMemberId: 'task-failed' });
    rerender(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-usage-duration').textContent).toBe('12 秒'));
    expect(screen.getByTestId('member-usage').textContent).not.toContain('—');
  });

  it('falls back to updatedAt when a terminal plain task lacks completedAt and durationMs', async () => {
    const failedTask = plainTaskOf({
      id: 'task-failed-no-completed',
      status: 'failed',
      createdAt: 5_000,
      completedAt: undefined,
      updatedAt: 13_000,
      durationMs: undefined,
    });
    useBackgroundTaskStore.setState({ tasks: [failedTask] });
    useMemberViewStore.setState({ viewingMemberId: 'task-failed-no-completed' });

    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-usage-duration').textContent).toBe('8 秒'));
  });

  it('ticks every second for a running plain task, stops when finished, and cleans up on unmount', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    const runningTask = plainTaskOf({
      id: 'task-running',
      status: 'running',
      createdAt: 97_000,
      updatedAt: 99_000,
      completedAt: undefined,
      durationMs: undefined,
    });
    useBackgroundTaskStore.setState({ tasks: [runningTask] });
    useMemberViewStore.setState({ viewingMemberId: 'task-running' });

    const { unmount } = render(<MemberConversationView sessionId="session-1" />);
    expect(screen.getByTestId('member-usage-duration').textContent).toBe('3 秒');
    expect(setIntervalSpy.mock.calls.filter((call) => call[1] === 1000)).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId('member-usage-duration').textContent).toBe('6 秒');

    // Transition to completed -> freezes duration and stops interval
    act(() => {
      useBackgroundTaskStore.setState({
        tasks: [{ ...runningTask, status: 'completed', completedAt: 103_000, updatedAt: 103_000 }],
      });
    });
    expect(screen.getByTestId('member-usage-duration').textContent).toBe('6 秒');
    expect(clearIntervalSpy).toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByTestId('member-usage-duration').textContent).toBe('6 秒');

    unmount();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('does not start a timer for an already completed plain task', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100_000));
    const setIntervalSpy = vi.spyOn(window, 'setInterval');

    const doneTask = plainTaskOf({
      id: 'task-done',
      status: 'completed',
      createdAt: 90_000,
      completedAt: 95_000,
      updatedAt: 95_000,
      durationMs: undefined,
    });
    useBackgroundTaskStore.setState({ tasks: [doneTask] });
    useMemberViewStore.setState({ viewingMemberId: 'task-done' });

    render(<MemberConversationView sessionId="session-1" />);
    expect(screen.getByTestId('member-usage-duration').textContent).toBe('5 秒');
    expect(setIntervalSpy.mock.calls.filter((call) => call[1] === 1000)).toHaveLength(0);
    setIntervalSpy.mockRestore();
  });

  it('renders expert-member elapsed time for completed and running states and hides clock when startTime is missing', async () => {
    setupExpertFixture({ startTime: 10_000, endTime: 75_000, status: 'completed' });
    useMemberViewStore.setState({ viewingMemberId: 'researcher' });

    const { unmount } = render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-usage-duration').textContent).toBe('1 分 5 秒'));
    unmount();

    // Missing startTime hides clock and number while preserving tool calls / tokens / cost
    setupExpertFixture({ startTime: null, endTime: null, durationMs: null, status: 'completed' }, { startTime: undefined, endTime: undefined });
    const { unmount: unmountMissing } = render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-usage')).toBeTruthy());
    expect(screen.queryByTestId('member-usage-duration')).toBeNull();
    expect(screen.getByTestId('member-usage').textContent).toContain('4 次工具调用');
    expect(screen.getByTestId('member-usage').textContent).not.toContain('—');
    unmountMissing();

    // Running expert member ticks every second
    vi.useFakeTimers();
    vi.setSystemTime(new Date(20_000));
    setupExpertFixture({ startTime: 18_000, endTime: null, durationMs: null, status: 'running' }, { startTime: 18_000, endTime: undefined, status: 'running' });
    render(<MemberConversationView sessionId="session-1" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('member-usage-duration').textContent).toBe('2 秒');
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(screen.getByTestId('member-usage-duration').textContent).toBe('6 秒');
  });
});
