import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { TaskManagerEvent } from '../../../src/host/task/taskManagerTypes';

const sessionManagerState = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const orchestratorState = vi.hoisted(() => ({
  messageRuns: [] as Message[][],
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {
    private readonly messages = orchestratorState.messageRuns.shift() ?? [];
    sendMessage = vi.fn().mockResolvedValue(undefined);
    setSessionId = vi.fn();
    setMessages = vi.fn();
    setWorkingDirectory = vi.fn();
    setWorkspaceScopeAuthority = vi.fn();
    getMessages = () => this.messages;
  },
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
  hasInteractiveUi: () => false,
}));

vi.mock('../../../src/host/task/backgroundTaskSessionContext', () => ({
  getBackgroundTaskSessionContext: (sessionId: string) => sessionManagerState.getSession(sessionId),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: (name: string) => {
      if (name === 'Write' || name === 'Edit') return { permissionLevel: 'write' };
      if (name === 'Read' || name === 'read_xlsx') return { permissionLevel: 'read' };
      return undefined;
    },
  }),
}));

import { TaskManager } from '../../../src/host/task/TaskManager';
import { SessionCommandCenter } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import {
  getBackgroundTaskLedger,
  resetBackgroundTaskLedgerForTest,
} from '../../../src/host/task/backgroundTaskLedger';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

type EventData = {
  taskId?: string;
  conclusion?: string;
  error?: string;
  artifacts?: Array<{ artifactId?: string; path?: string }>;
};

function artifact(artifactId: string, path: string, role = 'deliverable') {
  return {
    artifactId,
    kind: path.endsWith('.xlsx') ? 'spreadsheet' : 'document',
    role,
    sourceTool: path.endsWith('.xlsx') ? 'read_xlsx' : 'Write',
    path,
  };
}

function messages(input: {
  calls: Array<{ id: string; name: string; success: boolean; artifact?: ReturnType<typeof artifact> }>;
  conclusion: string;
}): Message[] {
  return [
    {
      id: 'assistant-tools',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: input.calls.map((call) => ({ id: call.id, name: call.name, arguments: {} })),
    },
    {
      id: 'tool-results',
      role: 'tool',
      content: '',
      timestamp: 2,
      toolResults: input.calls.map((call) => ({
        toolCallId: call.id,
        success: call.success,
        ...(call.success ? { output: 'ok' } : { error: 'save failed' }),
        ...(call.artifact ? { metadata: { artifact: call.artifact } } : {}),
      })),
    },
    { id: 'assistant-final', role: 'assistant', content: input.conclusion, timestamp: 3 },
  ];
}

async function runBackgroundTask(runMessages: Message[]): Promise<TaskManagerEvent> {
  orchestratorState.messageRuns.push(runMessages);
  const manager = new TaskManager({ maxConcurrentTasks: 1 });
  manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
  const terminalEvents: TaskManagerEvent[] = [];
  manager.on('event', (event: TaskManagerEvent) => {
    if (event.type === 'task_completed' || event.type === 'task_error') terminalEvents.push(event);
  });

  await manager.startBackgroundTask('task-1', 'session-1', 'do the work');

  expect(terminalEvents).toHaveLength(1);
  return terminalEvents[0];
}

describe('TaskManager background delivery verdict', () => {
  beforeEach(() => {
    orchestratorState.messageRuns.length = 0;
    sessionManagerState.getSession.mockReset().mockResolvedValue(undefined);
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
  });

  it('keeps a successful write completed with its artifact', async () => {
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'write-1', name: 'Write', success: true, artifact: artifact('report-1', '/work/report.md') }],
      conclusion: 'Report saved.',
    }));

    expect(event.type).toBe('task_completed');
    expect(event.data as EventData).toMatchObject({
      conclusion: 'Report saved.',
      artifacts: [{ artifactId: 'report-1', path: '/work/report.md' }],
    });
  });

  it('emits task_error with the conclusion when every write failed and nothing was delivered', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'write-1', name: 'Write', success: false },
        { id: 'edit-1', name: 'Edit', success: false },
      ],
      conclusion: 'I could not save the requested report.',
    }));

    expect(event.type).toBe('task_error');
    expect(event.data as EventData).toMatchObject({
      error: 'I could not save the requested report.',
    });
  });

  it('persists the all-writes-failed event as a failed command-center row with the conclusion', async () => {
    orchestratorState.messageRuns.push(messages({
      calls: [{ id: 'write-1', name: 'Write', success: false }],
      conclusion: 'I could not save the requested report.',
    }));
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
    const center = new SessionCommandCenter(manager, {
      projectTerminalResult: vi.fn(),
      persistMemberInput: vi.fn(),
      wakeForegroundBrain: vi.fn(),
    });

    const spawned = await center.spawn({
      sessionId: 'session-1',
      title: 'Save report',
      shortName: 'report',
      laneKey: 'report',
      submissionKey: 'report-1',
      prompt: 'save the report',
      workspaceScope: createWorkspaceScope('project-1', [{
        sourceId: 'primary',
        path: '/work',
        role: 'primary',
        access: 'read_write',
      }]),
    });
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');

    await vi.waitFor(() => expect(center.list('session-1')[0]).toMatchObject({
      status: 'failed',
      detail: 'I could not save the requested report.',
    }));
    expect(getBackgroundTaskLedger().listTasks({ sessionId: 'session-1' })[0]).toMatchObject({
      status: 'failed',
      summary: 'I could not save the requested report.',
      outputRefs: [],
    });
    center.dispose();
  });

  it('keeps mixed failed and successful writes completed', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'write-1', name: 'Write', success: false },
        { id: 'write-2', name: 'Write', success: true },
      ],
      conclusion: 'The retry succeeded.',
    }));

    expect(event.type).toBe('task_completed');
    expect(event.data as EventData).toMatchObject({ conclusion: 'The retry succeeded.' });
  });

  it('keeps a no-write research task completed', async () => {
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'read-1', name: 'Read', success: true }],
      conclusion: 'The research answer is 42.',
    }));

    expect(event.type).toBe('task_completed');
    expect(event.data as EventData).toMatchObject({ conclusion: 'The research answer is 42.' });
  });

  it('does not expose four read_xlsx source artifacts as outputs', async () => {
    const source = artifact('sales-input', '/work/sales.xlsx', 'material');
    const event = await runBackgroundTask(messages({
      calls: Array.from({ length: 4 }, (_, index) => ({
        id: `read-xlsx-${index}`,
        name: 'read_xlsx',
        success: true,
        artifact: source,
      })),
      conclusion: 'The workbook was analyzed.',
    }));

    expect(event.type).toBe('task_completed');
    expect(event.data as EventData).not.toHaveProperty('artifacts');
  });

  it('keeps only the first artifact when writes report the same path twice', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'write-1', name: 'Write', success: true, artifact: artifact('first', '/work/report.md') },
        { id: 'write-2', name: 'Write', success: true, artifact: artifact('second', '/work/report.md') },
      ],
      conclusion: 'Report saved.',
    }));

    expect(event.type).toBe('task_completed');
    expect((event.data as EventData).artifacts).toEqual([
      expect.objectContaining({ artifactId: 'first', path: '/work/report.md' }),
    ]);
  });
});
