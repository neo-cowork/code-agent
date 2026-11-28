// @vitest-environment jsdom
// 成员页「运行轨迹」把落库的原始 eventType 映射为当前界面语言的人话，不裸露 event.title / event.summary / 代理内部 ID。
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import type { SwarmAgentState } from '../../../src/shared/contract/swarm';
import type {
  SwarmRunAgentRecord,
  SwarmRunDetail,
  SwarmRunEventRecord,
  SwarmRunListItem,
} from '../../../src/shared/contract/swarmTrace';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const lang = vi.hoisted(() => ({ t: undefined as unknown }));
const swarmState: { agents: SwarmAgentState[]; activeSessionId: string | undefined; messages: never[] } = {
  agents: [], activeSessionId: 'session-1', messages: [],
};

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: lang.t }) }));
vi.mock('../../../src/renderer/stores/swarmStore', () => ({
  useSwarmStore: (selector: (state: typeof swarmState) => unknown) => selector(swarmState),
}));
const invokeMock = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: (...args: unknown[]) => invokeMock(...args), invokeDomain: vi.fn().mockResolvedValue(null) },
}));

import { MemberConversationView } from '../../../src/renderer/components/features/expert/MemberConversationView';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const RAW_AGENT_ID = 'swarm-agent.v1.d2ViLXNlc3Npb24tMWQ5MzExZTItNDAyZi00YTkzLThkMjctMDYzOTFmNjNmMTBj.YWdlbnRfMA';
const OTHER_AGENT_ID = 'swarm-agent.v1.d2ViLXNlc3Npb24tMWQ5MzExZTItNDAyZi00YTkzLThkMjctMDYzOTFmNjNmMTBj.YWdlbnRfMQ';

const record: SwarmRunAgentRecord = {
  runId: 'run-1', agentId: RAW_AGENT_ID, name: '调研员', role: 'researcher', status: 'completed',
  startTime: 1, endTime: 4_001, durationMs: 4_000, tokensIn: 12, tokensOut: 34, toolCalls: 3, costUsd: 0.001,
  error: null, failureCategory: null, filesChanged: [], dispatchedTask: '整理会议纪要要点', finalOutput: '三条要点已汇总',
};
const otherRecord: SwarmRunAgentRecord = {
  ...record, agentId: OTHER_AGENT_ID, name: '撰稿员', role: 'writer', dispatchedTask: '合成对比表', finalOutput: '对比表初稿',
};
const ledgerRun: SwarmRunListItem = {
  id: 'run-1', sessionId: 'session-1', status: 'completed', coordinator: 'parallel', startedAt: 1, endedAt: 5_001,
  durationMs: 5_000, totalAgents: 2, completedCount: 2, failedCount: 0, totalCostUsd: 0.002,
  totalTokensIn: 24, totalTokensOut: 68, trigger: 'llm-spawn',
};

const FORBIDDEN_SUBSTRINGS = [
  'agent:updated',
  'context:update',
  'swarm:',
  'swarm-agent.v1.',
  'completed=',
  'failed=',
  '→',
  'startup recovery',
] as const;

const CASES = [
  {
    name: 'zh',
    t: zh,
    expectedCounts: '完成 2 项、失败 0 项',
  },
  {
    name: 'en',
    t: en,
    expectedCounts: 'Done: 2 · Failed: 0',
  },
] as const;

function detailWithEvents(events: SwarmRunEventRecord[]): SwarmRunDetail {
  return {
    run: { ...ledgerRun, totalToolCalls: 6, parallelPeak: 2, errorSummary: null, aggregation: null, tags: [] },
    agents: [record, otherRecord],
    events,
  };
}

describe.each(CASES)('成员页运行轨迹事件名映射 ($name)', ({ t, expectedCounts }) => {
  const copy = t.expert.memberBar.runTrailEvents;

  beforeEach(() => {
    lang.t = t;
    invokeMock.mockReset();
    swarmState.agents = [];
    useBackgroundTaskStore.setState({ tasks: [] });
    useAppStore.setState({ pendingPermissionRequest: null, pendingPermissionSessionId: null, queuedPermissionRequests: {} });
    useMemberViewStore.setState({ viewingMemberId: RAW_AGENT_ID });
  });
  afterEach(() => cleanup());

  it('maps writer-shaped rows, completed counts, payload-less completed, startup-recovery cancel, and unknown eventType without leaking raw tokens', async () => {
    const events: SwarmRunEventRecord[] = [
      {
        id: 1, runId: 'run-1', seq: 1, timestamp: 1_000,
        eventType: 'swarm:agent:updated', agentId: RAW_AGENT_ID, level: 'info',
        title: 'agent:updated', summary: `${RAW_AGENT_ID} → running`,
        payload: { agentId: RAW_AGENT_ID, agentState: { id: RAW_AGENT_ID, status: 'running' } },
      },
      {
        id: 2, runId: 'run-1', seq: 2, timestamp: 2_000,
        eventType: 'swarm:context:update', agentId: null, level: 'info',
        title: 'context:update', summary: 'swarm:context:update',
        payload: {},
      },
      {
        id: 3, runId: 'run-1', seq: 3, timestamp: 3_000,
        eventType: 'swarm:agent:completed', agentId: RAW_AGENT_ID, level: 'info',
        title: 'agent:completed', summary: `${RAW_AGENT_ID} → completed`,
        payload: { agentId: RAW_AGENT_ID, agentState: { id: RAW_AGENT_ID, status: 'completed' } },
      },
      {
        id: 4, runId: 'run-1', seq: 4, timestamp: 4_000,
        eventType: 'swarm:completed', agentId: null, level: 'info',
        title: 'completed', summary: 'completed=2 failed=0',
        payload: { statistics: { completed: 2, failed: 0 } },
      },
      {
        id: 5, runId: 'run-1', seq: 5, timestamp: 5_000,
        eventType: 'swarm:completed', agentId: null, level: 'info',
        title: 'completed', summary: 'completed=2 failed=0',
        payload: null,
      },
      {
        id: 6, runId: 'run-1', seq: 6, timestamp: 6_000,
        eventType: 'swarm:cancelled', agentId: null, level: 'warn',
        title: 'cancelled (startup recovery)',
        summary: '应用重启后未发现存活进程，运行已收口为取消（1 个未完成成员）',
        payload: { recoveredBy: 'swarmTraceStartupRecovery', agentsCancelled: 1 },
      },
      {
        id: 7, runId: 'run-1', seq: 7, timestamp: 7_000,
        eventType: 'swarm:future:thing', agentId: RAW_AGENT_ID, level: 'info',
        title: 'future:thing', summary: 'swarm:future:thing',
        payload: { raw: 'future:thing' },
      },
    ];

    invokeMock.mockImplementation((channel: unknown) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([ledgerRun]);
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) return Promise.resolve(detailWithEvents(events));
      return Promise.resolve(null);
    });

    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-run-trail')).toBeTruthy());

    const trail = screen.getByTestId('member-run-trail');
    const trailText = trail.textContent ?? '';
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(trailText).not.toContain(forbidden);
    }
    expect(trailText).not.toContain('future:thing');
    expect(trailText).not.toContain('应用重启后未发现存活进程');

    // Reversed order: seq 7 first, seq 1 last
    const rows = screen.getAllByTestId('member-run-trail-event');
    expect(rows).toHaveLength(7);
    expect(rows[0].textContent).toContain(copy.fallback);
    expect(rows[0].querySelector('p')).toBeNull();

    expect(rows[1].textContent).toContain(copy.cancelled);
    expect(rows[1].querySelector('p')).toBeNull();

    // seq 5: swarm:completed without payload -> no detail paragraph
    expect(rows[2].textContent).toContain(copy.completed);
    expect(rows[2].querySelector('p')).toBeNull();

    // seq 4: swarm:completed with numeric statistics -> localized counts detail
    expect(rows[3].textContent).toContain(copy.completed);
    expect(rows[3].querySelector('p')?.textContent).toBe(expectedCounts);

    expect(rows[4].textContent).toContain(copy.agentCompleted);
    expect(rows[4].querySelector('p')).toBeNull();

    expect(rows[5].textContent).toContain(copy.contextUpdate);
    expect(rows[5].querySelector('p')).toBeNull();

    expect(rows[6].textContent).toContain(copy.agentUpdated);
    expect(rows[6].querySelector('p')).toBeNull();
  });

  it('consumes persisted lifecycle events for this member + run-level only, in reverse chronological order, and maps remaining event types', async () => {
    const events: SwarmRunEventRecord[] = [
      {
        id: 1, runId: 'run-1', seq: 1, timestamp: 1_000,
        eventType: 'swarm:started', agentId: null, level: 'info',
        title: 'started', summary: 'started total=2',
        payload: { statistics: { total: 2 } },
      },
      {
        id: 2, runId: 'run-1', seq: 2, timestamp: 2_000,
        eventType: 'swarm:agent:added', agentId: RAW_AGENT_ID, level: 'info',
        title: 'agent:added', summary: `${RAW_AGENT_ID} → pending`,
        payload: null,
      },
      {
        id: 3, runId: 'run-1', seq: 3, timestamp: 3_000,
        eventType: 'swarm:agent:message', agentId: RAW_AGENT_ID, level: 'info',
        title: 'agent:message', summary: 'swarm:agent:message',
        payload: null,
      },
      {
        id: 4, runId: 'run-1', seq: 4, timestamp: 4_000,
        eventType: 'swarm:user:message', agentId: RAW_AGENT_ID, level: 'info',
        title: 'user:message', summary: 'swarm:user:message',
        payload: null,
      },
      {
        id: 5, runId: 'run-1', seq: 5, timestamp: 5_000,
        eventType: 'swarm:agent:failed', agentId: RAW_AGENT_ID, level: 'error',
        title: 'agent:failed', summary: `${RAW_AGENT_ID} → failed`,
        payload: null,
      },
      {
        id: 6, runId: 'run-1', seq: 6, timestamp: 6_000,
        eventType: 'swarm:completed', agentId: null, level: 'info',
        title: 'completed', summary: 'completed=1 failed=1',
        payload: { statistics: { completed: 'two', failed: null } },
      },
      {
        id: 7, runId: 'run-1', seq: 7, timestamp: 7_000,
        eventType: 'swarm:agent:completed', agentId: OTHER_AGENT_ID, level: 'info',
        title: 'agent:completed', summary: `${OTHER_AGENT_ID} → completed`,
        payload: null,
      },
    ];

    invokeMock.mockImplementation((channel: unknown) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([ledgerRun]);
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) return Promise.resolve(detailWithEvents(events));
      return Promise.resolve(null);
    });

    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-run-trail')).toBeTruthy());

    const trail = screen.getByTestId('member-run-trail');
    const trailText = trail.textContent ?? '';
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(trailText).not.toContain(forbidden);
    }
    // Other member's completed event (seq 7) is filtered out
    expect(trailText).not.toContain(copy.agentCompleted);

    // Reverse chronological order: seq 6 -> seq 1
    const rows = screen.getAllByTestId('member-run-trail-event');
    expect(rows).toHaveLength(6);
    expect(rows[0].textContent).toContain(copy.completed);
    // Non-numeric statistics -> detail omitted
    expect(rows[0].querySelector('p')).toBeNull();
    expect(rows[1].textContent).toContain(copy.agentFailed);
    expect(rows[2].textContent).toContain(copy.userMessage);
    expect(rows[3].textContent).toContain(copy.agentMessage);
    expect(rows[4].textContent).toContain(copy.agentAdded);
    expect(rows[5].textContent).toContain(copy.started);
  });
});
