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
    private messages: Message[] = [];
    private readonly runMessages = orchestratorState.messageRuns.shift() ?? [];
    sendMessage = vi.fn(async () => { this.messages.push(...this.runMessages); });
    setSessionId = vi.fn();
    setMessages = (history: Message[]) => { this.messages = [...history]; };
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

describe('TaskManager background history isolation', () => {
  beforeEach(() => {
    orchestratorState.messageRuns.length = 0;
    sessionManagerState.getSession.mockReset();
  });

  function inherit(calls: Parameters<typeof messages>[0]['calls']) {
    sessionManagerState.getSession.mockResolvedValue({
      messages: messages({ calls, conclusion: 'Earlier conversation conclusion.' })
        .map((message) => ({ ...message, id: `history-${message.id}` })),
    });
  }

  it('completes read-only research despite a failed write in inherited history', async () => {
    inherit([{ id: 'old-write', name: 'Write', success: false }]);
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'new-read', name: 'Read', success: true }],
      conclusion: 'The research answer is 42.',
    }));
    expect(event.type).toBe('task_completed');
    expect(event.data as EventData).toMatchObject({ conclusion: 'The research answer is 42.' });
    expect(event.data as EventData).not.toHaveProperty('artifacts');
  });

  it('does not let an inherited successful write mask current delivery failure', async () => {
    inherit([{ id: 'old-write', name: 'Write', success: true }]);
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'new-write', name: 'Write', success: false }],
      conclusion: 'The new report could not be saved.',
    }));
    expect(event.type).toBe('task_error');
    expect(event.data as EventData).toMatchObject({ error: 'The new report could not be saved.' });
  });

  it('does not collect inherited deliverables or let them mask current delivery failure', async () => {
    inherit([{ id: 'old-read', name: 'Read', success: true,
      artifact: artifact('old-report', '/work/old-report.md') }]);
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'new-write', name: 'Write', success: false }],
      conclusion: 'The new report could not be saved.',
    }));
    expect(event.type).toBe('task_error');
    expect(event.data as EventData).toMatchObject({ error: 'The new report could not be saved.' });
    expect(event.data as EventData).not.toHaveProperty('artifacts');
  });
});
