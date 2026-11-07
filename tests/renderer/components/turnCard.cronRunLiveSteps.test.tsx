// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobExecution } from '../../../src/shared/contract/cron';
import type { Message, ToolResult } from '../../../src/shared/contract';
import { CronRunSessionStatusBar } from '../../../src/renderer/components/features/chat/CronRunSessionStatusBar';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { cronClient } from '../../../src/renderer/services/cronClient';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { hydrateToolCallResults } from '../../../src/renderer/utils/messageHydration';

const SESSION_ID = 'cron-live-session';
const JOB_ID = 'cron-live-job';
const EXECUTION_ID = 'cron-live-execution';
const domainInvokeMock = vi.fn();

const runSession = {
  id: SESSION_ID,
  title: '[Schedule] live steps',
  readOnly: true,
  origin: { kind: 'cron', id: JOB_ID, name: 'live steps' },
  sourceRunId: EXECUTION_ID,
  createdAt: 1_000,
  updatedAt: 5_000,
  messageCount: 5,
  turnCount: 1,
} as SessionWithMeta;

function execution(status: CronJobExecution['status']): CronJobExecution {
  return {
    id: EXECUTION_ID,
    jobId: JOB_ID,
    status,
    scheduledAt: 1_000,
    startedAt: 1_500,
    completedAt: status === 'completed' ? 5_000 : undefined,
    duration: status === 'completed' ? 3_500 : undefined,
    retryAttempt: 0,
    sessionId: SESSION_ID,
  };
}

const toolResults: ToolResult[] = [
  { toolCallId: 'write-failed', success: false, error: 'Write failed', duration: 10 },
  { toolCallId: 'read-ok', success: true, output: 'saved content', duration: 20 },
  { toolCallId: 'write-denied', success: false, error: 'Permission denied by user', duration: 30 },
];

const toolCalls = [
  { id: 'write-failed', name: 'Write', arguments: { file_path: '/tmp/failed.txt', content: 'first' } },
  { id: 'read-ok', name: 'Read', arguments: { file_path: '/tmp/saved.txt' } },
  { id: 'write-denied', name: 'Write', arguments: { file_path: '/tmp/denied.txt', content: 'third' } },
];

let persistedMessages: Message[] = [];
let parkedApprovals: unknown[] = [];

function storedRunMessages(results: ToolResult[] = toolResults): Message[] {
  const resultIds = new Set(results.map((result) => result.toolCallId));
  return [
    { id: 'user-1', role: 'user', content: 'Run the scheduled check', timestamp: 1_000 },
    {
      id: 'assistant-1', role: 'assistant', content: '', timestamp: 2_000,
      toolCalls: toolCalls.filter((toolCall) => resultIds.has(toolCall.id)),
    },
    ...results.map((result, index) => ({
      id: `tool-result-${index}`,
      role: 'tool' as const,
      content: JSON.stringify([result]),
      timestamp: 3_000 + index,
      toolResults: [result],
    })),
  ];
}

const StoredRunView: React.FC = () => {
  const messages = useSessionStore((state) => state.messages);
  const projection = projectTurns(messages, SESSION_ID, false);
  expect(projection.turns).toHaveLength(1);
  return (
    <TurnCard
      turn={projection.turns[0]}
      sessionId={SESSION_ID}
      afterUserMessage={<CronRunSessionStatusBar sessionId={SESSION_ID} />}
    />
  );
};

function renderStoredRun(messages: Message[]): void {
  const hydrated = hydrateToolCallResults(messages);
  useSessionStore.setState({
    sessions: [runSession],
    currentSessionId: SESSION_ID,
    messages: hydrated,
    isHydratingSession: false,
    error: null,
  });
  render(<StoredRunView />);
}

describe('TurnCard live cron run steps', () => {
  beforeEach(() => {
    useAppStore.setState({ disclosureLevel: 'standard', language: 'en' });
    persistedMessages = storedRunMessages();
    parkedApprovals = [];
    domainInvokeMock.mockReset().mockImplementation(async (_domain: string, action: string) => {
      if (action === 'load') {
        return {
          success: true,
          data: { ...runSession, status: 'running', activeRun: true, messages: persistedMessages, todos: [] },
        };
      }
      if (action === 'getSessionTasks') return { success: true, data: [] };
      if (action === 'listParkedApprovals') return { success: true, data: parkedApprovals };
      return { success: true, data: null };
    });
    (window as unknown as { domainAPI?: { invoke: typeof domainInvokeMock } }).domainAPI = {
      invoke: domainInvokeMock,
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as unknown as { domainAPI?: unknown }).domainAPI;
    useAppStore.setState({ disclosureLevel: 'standard', language: 'zh' });
  });

  it('shows three persisted tool steps while the cron execution is running', async () => {
    vi.spyOn(cronClient, 'getExecutions').mockResolvedValue([execution('running')]);
    renderStoredRun(storedRunMessages());

    expect((await screen.findByTestId('cron-run-status')).dataset.state).toBe('running');
    expect(screen.getAllByTestId('tool-call-row-Write')).toHaveLength(2);
    expect(screen.getAllByTestId('tool-group-head-label')).toHaveLength(1);
    expect(screen.getByTestId('tool-group-head-label').textContent).toContain('Read');
  });

  it('reloads a tool step appended in the database while the execution stays running without remounting', async () => {
    const initialResults = toolResults.slice(0, 2);
    persistedMessages = storedRunMessages(initialResults);
    vi.spyOn(cronClient, 'getExecutions').mockResolvedValue([execution('running')]);
    renderStoredRun(persistedMessages);

    const statusLine = await screen.findByTestId('cron-run-status');
    await waitFor(() => {
      expect(screen.queryAllByTestId('tool-call-row-Write')).toHaveLength(1);
      expect(screen.queryAllByTestId('tool-group-head-label')).toHaveLength(1);
      expect(useSessionStore.getState().isHydratingSession).toBe(false);
    });
    persistedMessages = storedRunMessages();

    await waitFor(() => {
      expect(screen.queryAllByTestId('tool-call-row-Write')).toHaveLength(2);
    }, { timeout: 5_000 });
    expect(screen.getByTestId('cron-run-status')).toBe(statusLine);
    expect(screen.getByTestId('cron-run-status').dataset.state).toBe('running');
  });

  it('shows awaiting approval status, approve and deny actions, and persisted steps together', async () => {
    parkedApprovals = [{
      id: 'approval-1', sessionId: SESSION_ID, tool: 'Write', displayTool: 'Write',
      argsPreview: '/tmp/denied.txt', requestedAt: 4_000, status: 'pending',
    }];
    vi.spyOn(cronClient, 'getExecutions').mockResolvedValue([execution('running')]);
    renderStoredRun(storedRunMessages());

    expect((await screen.findByTestId('cron-run-status')).dataset.state).toBe('awaiting');
    expect(screen.getByTestId('cron-run-status-approve')).toBeTruthy();
    expect(screen.getByTestId('cron-run-status-reject')).toBeTruthy();
    expect(screen.getAllByTestId('tool-call-row-Write')).toHaveLength(2);
    expect(screen.getByTestId('tool-group-head-label').textContent).toContain('Read');
  });

  it('folds again when a running cron execution finishes while keeping the status line and final summary', async () => {
    const messages = [
      ...storedRunMessages(),
      { id: 'assistant-summary', role: 'assistant' as const, content: 'Scheduled run summary', timestamp: 5_000 },
    ];
    persistedMessages = messages;
    let status: CronJobExecution['status'] = 'running';
    vi.spyOn(cronClient, 'getExecutions').mockImplementation(async () => [execution(status)]);
    renderStoredRun(messages);

    expect((await screen.findByTestId('cron-run-status')).dataset.state).toBe('running');
    expect(screen.getAllByTestId('tool-call-row-Write')).toHaveLength(2);
    status = 'completed';

    await waitFor(() => {
      expect(screen.getByTestId('cron-run-status').dataset.state).toBe('finished');
    }, { timeout: 5_000 });
    expect(screen.getByText('Scheduled run summary')).toBeTruthy();
    expect(screen.queryByTestId('tool-call-row-Write')).toBeNull();
    expect(screen.queryByTestId('tool-group-head-label')).toBeNull();
  });
});
