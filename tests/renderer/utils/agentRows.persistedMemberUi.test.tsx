// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import type { SwarmRunAgentRecord, SwarmRunDetail, SwarmRunListItem } from '../../../src/shared/contract/swarmTrace';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const invokeMock = vi.fn();
const invokeDomainMock = vi.fn();
const appState = {
  language: 'zh' as 'zh' | 'en',
  openWorkspacePreview: vi.fn(),
  openWorkbenchTab: vi.fn(),
  setWorkbenchCollapsed: vi.fn(),
  workbenchTabs: [] as string[],
  pendingPermissionRequest: null,
  pendingPermissionSessionId: null,
  queuedPermissionRequests: {},
  activeAgentId: null,
  developerMode: false,
};

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: appState.language === 'en' ? en : zh }),
}));
vi.mock('../../../src/renderer/stores/appStore', () => {
  const useAppStore = (selector: (state: typeof appState) => unknown) => selector(appState);
  useAppStore.getState = () => appState;
  return { useAppStore };
});
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    invokeDomain: (...args: unknown[]) => invokeDomainMock(...args),
  },
}));

import { SessionMemberBar } from '../../../src/renderer/components/features/expert/SessionMemberBar';
import { SessionAgentsPanel } from '../../../src/renderer/components/TaskPanel/SessionAgentsPanel';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';
import { useAgentRegistryStore } from '../../../src/renderer/stores/agentRegistryStore';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';

describe('persisted failed member UI consumers (SessionMemberBar + SessionAgentsPanel)', () => {
  const failedMember: SwarmRunAgentRecord = {
    runId: 'run-1',
    agentId: 'analyst',
    name: '数据分析师',
    role: 'analyst',
    status: 'failed',
    startTime: 1,
    endTime: 2,
    durationMs: 1,
    tokensIn: 0,
    tokensOut: 0,
    toolCalls: 0,
    costUsd: 0,
    error: "Failed to create worktree for agent: Command failed: git rev-parse 'HEAD'\nfatal: not a git repository (or any of the parent directories): .git\n. Ensure you are in a git repository.",
    failureCategory: 'worktree_create_failed',
    filesChanged: [],
    dispatchedTask: 'Budget analyst',
  };

  const runItem: SwarmRunListItem = {
    id: 'run-1',
    sessionId: 'session-1',
    status: 'failed',
    coordinator: 'parallel',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    totalAgents: 1,
    completedCount: 0,
    failedCount: 1,
    totalCostUsd: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    trigger: 'llm-spawn',
  };

  const detail: SwarmRunDetail = {
    run: { ...runItem, totalToolCalls: 0, parallelPeak: 1, errorSummary: failedMember.error, aggregation: null, tags: [] },
    agents: [failedMember],
    events: [],
  };

  beforeEach(() => {
    appState.language = 'zh';
    invokeMock.mockReset();
    invokeDomainMock.mockReset();
    invokeDomainMock.mockResolvedValue(null);
    invokeMock.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([runItem]);
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) return Promise.resolve(detail);
      return Promise.resolve(null);
    });
    useSwarmStore.setState({ activeSessionId: undefined, activeRunId: undefined, activeTreeId: undefined, lastEventAt: undefined, eventLog: [], agents: [] });
    useComposerStore.setState({ selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
    useTeamRecipeStore.setState({ recipes: [], isLoaded: true });
    useAgentRegistryStore.setState({ entries: [], isLoaded: true });
    useMemberViewStore.setState({ viewingMemberId: null });
    useBackgroundTaskStore.setState({ tasks: [] });
    useSessionStore.setState({ sessions: [], currentSessionId: 'session-1' });
  });

  afterEach(() => cleanup());

  it.each(['zh', 'en'] as const)('renders humanized worktree failure reason in both SessionMemberBar title and SessionAgentsPanel (%s)', async (language) => {
    appState.language = language;
    const t = language === 'zh' ? zh : en;
    const expectedReason = t.toolStepHumanize.failureCodes['worktree-create-failed'];

    render(
      <>
        <SessionMemberBar sessionId="session-1" />
        <SessionAgentsPanel />
      </>,
    );

    const chip = await screen.findByTestId('session-member-bar-collapsed');
    expect(chip.textContent).toContain(language === 'zh' ? '1 个代理 · 失败 · 数据分析师' : '1 agent · Failed · 数据分析师');
    expect(chip.getAttribute('title')).toBe(
      t.chat.delegationReceipt.failureDetail.replace('{status}', '数据分析师').replace('{reason}', expectedReason),
    );
    expect(chip.getAttribute('title')).not.toContain('git rev-parse');

    const panelStatus = await screen.findByTestId('agents-panel-status-analyst');
    expect(panelStatus.textContent).toBe(
      t.chat.delegationReceipt.failureDetail
        .replace('{status}', t.expert.memberBar.panel.status.failed)
        .replace('{reason}', expectedReason),
    );
    expect(panelStatus.textContent).not.toContain('git rev-parse');
  });
});
