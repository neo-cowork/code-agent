// @vitest-environment jsdom
// 委派 Bash 步骤的「未执行」：成员页当前动作条 / 最近动作（普通代理 + swarm 成员）按步骤自带的 notRun 落字，zh / en 各一遍。
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { SwarmAgentState } from '../../../src/shared/contract/swarm';
import type { SwarmRunAgentRecord, SwarmRunDetail, SwarmRunListItem } from '../../../src/shared/contract/swarmTrace';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const lang = vi.hoisted(() => ({ t: undefined as unknown }));
const swarmState: { agents: SwarmAgentState[]; activeSessionId: string | undefined; messages: never[] } = {
  agents: [], activeSessionId: 'session-1', messages: [],
};

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: lang.t }) }));
vi.mock('../../../src/renderer/stores/swarmStore', () => ({ useSwarmStore: (selector: (state: typeof swarmState) => unknown) => selector(swarmState) }));
const invokeMock = vi.fn();
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: (...args: unknown[]) => invokeMock(...args), invokeDomain: vi.fn().mockResolvedValue(null) },
}));

import { MemberConversationView } from '../../../src/renderer/components/features/expert/MemberConversationView';
import { useMemberViewStore } from '../../../src/renderer/stores/memberViewStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const record: SwarmRunAgentRecord = {
  runId: 'run-1', agentId: 'researcher', name: '调研员', role: 'researcher', status: 'running',
  startTime: 1, endTime: null, durationMs: null, tokensIn: 1, tokensOut: 1, toolCalls: 2, costUsd: 0,
  error: null, failureCategory: null, filesChanged: [], dispatchedTask: '整理下载文件夹', finalOutput: '',
};
const ledgerRun: SwarmRunListItem = {
  id: 'run-1', sessionId: 'session-1', status: 'running', coordinator: 'parallel', startedAt: 1, endedAt: null, durationMs: null,
  totalAgents: 1, completedCount: 0, failedCount: 0, totalCostUsd: 0, totalTokensIn: 1, totalTokensOut: 1, trigger: 'llm-spawn',
};
const ledgerDetail: SwarmRunDetail = {
  run: { ...ledgerRun, totalToolCalls: 2, parallelPeak: 1, errorSummary: null, aggregation: null, tags: [] },
  agents: [record], events: [],
};

const CASES = [
  { name: 'zh', t: zh, d: ['看看下载文件夹里有什么', '新建 PDF 文件夹', '把 PDF 移进去'], prefix: '未执行' },
  { name: 'en', t: en, d: ['List what is in Downloads', 'Create a PDF folder', 'Move the PDFs in'], prefix: 'Not run' },
] as const;

function taskWith(descriptions: readonly string[], latestDenied: boolean): Task {
  const steps = descriptions.map((description, index) => ({
    description, command: `cmd-${index} ~/Downloads/secret`, callId: `c${index + 1}`,
    ...(index === 1 || (latestDenied && index === 2) ? { notRun: true } : {}),
  }));
  const last = steps[steps.length - 1];
  return {
    id: 'task-1', sessionId: 'session-1', source: 'delegate_task', title: 'tidy', summary: '', status: 'running',
    createdAt: 1, updatedAt: 2, events: [], outputRefs: [],
    progress: {
      lastToolStep: { tool: 'Bash', target: last.command, description: last.description, callId: last.callId, ...(last.notRun ? { notRun: true } : {}), at: 2 },
      bashSteps: steps,
    },
  } as Task;
}

describe.each(CASES)('成员页委派 Bash 未执行 ($name)', ({ t, d, prefix }) => {
  beforeEach(() => {
    lang.t = t;
    invokeMock.mockReset();
    invokeMock.mockImplementation((channel: unknown) => {
      if (channel === IPC_CHANNELS.SWARM_LIST_TRACE_RUNS) return Promise.resolve([ledgerRun]);
      if (channel === IPC_CHANNELS.SWARM_GET_TRACE_RUN_DETAIL) return Promise.resolve(ledgerDetail);
      return Promise.resolve(null);
    });
    swarmState.agents = [];
    useBackgroundTaskStore.setState({ tasks: [] });
    useAppStore.setState({ pendingPermissionRequest: null, pendingPermissionSessionId: null, queuedPermissionRequests: {} });
    useMemberViewStore.setState({ viewingMemberId: 'task-1' });
  });
  afterEach(() => cleanup());

  it('recent actions: only the denied step reads Not run; no raw command', async () => {
    useBackgroundTaskStore.setState({ tasks: [taskWith(d, false)] });
    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-bash-steps')).toBeTruthy());
    const rows = screen.getAllByTestId('member-bash-step').map((node) => node.textContent);
    expect(rows).toEqual([d[0], `${prefix} · ${d[1]}`, d[2]]);
    expect(screen.getByTestId('member-current-action').textContent).toBe(d[2]);
    expect(document.body.textContent).not.toContain('~/Downloads');
  });

  it('current-action bar: denied latest step reads Not run too', async () => {
    useBackgroundTaskStore.setState({ tasks: [taskWith(d, true)] });
    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-current-action')).toBeTruthy());
    expect(screen.getByTestId('member-current-action').textContent).toBe(`${prefix} · ${d[2]}`);
    expect(screen.getAllByTestId('member-bash-step').map((node) => node.textContent))
      .toEqual([d[0], `${prefix} · ${d[1]}`, `${prefix} · ${d[2]}`]);
    expect(document.body.textContent).not.toContain('~/Downloads');
  });

  it('swarm member recent actions read the same notRun', async () => {
    useMemberViewStore.setState({ viewingMemberId: 'researcher' });
    swarmState.agents = [{
      id: 'researcher', name: '调研员', role: 'researcher', status: 'running', iterations: 0,
      tokenUsage: { input: 0, output: 0 }, toolCalls: 0, filesChanged: [],
      contextSnapshot: {
        currentTokens: 1, maxTokens: 10, usagePercent: 1, messageCount: 1, warningLevel: 'normal', lastUpdated: 1,
        attachments: [], previews: [], truncatedMessages: 0, tools: ['Bash'],
        bashSteps: [
          { description: d[0], command: 'ls ~/Downloads', callId: 'c1' },
          { description: d[1], command: 'mkdir ~/Downloads/PDF', callId: 'c2', notRun: true },
        ],
      },
    } as SwarmAgentState];
    render(<MemberConversationView sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('member-recent-actions')).toBeTruthy());
    expect(screen.getAllByTestId('member-recent-action').map((node) => node.textContent))
      .toEqual([`${prefix} · ${d[1]}`, d[0]]);
  });
});
