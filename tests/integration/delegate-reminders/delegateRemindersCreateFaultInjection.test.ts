import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import type { AgentEvent, Message } from '../../../src/shared/contract';
import type { TaskManagerEvent } from '../../../src/host/task/TaskManager';

type TestSession = {
  id: string;
  title: string;
  messages: Message[];
  workingDirectory: string;
};

const sessionState = vi.hoisted(() => {
  const sessions = new Map<string, TestSession>();
  const manager = {
    getSession: vi.fn(async (id: string) => sessions.get(id) ?? null),
    getCurrentSession: vi.fn(async () => undefined),
    getCurrentSessionId: vi.fn(() => undefined),
    addMessageToSession: vi.fn(async (id: string, message: Message) => {
      const session = sessions.get(id);
      if (session) session.messages.push(message);
    }),
    addMessage: vi.fn(async () => undefined),
    updateSession: vi.fn(async () => undefined),
    getTodos: vi.fn(async () => []),
  };
  return { sessions, manager };
});

const databaseState = vi.hoisted(() => {
  const fallbackRepo = new Proxy({}, {
    get: () => vi.fn(() => undefined),
  });
  const db = new Proxy({ isReady: true }, {
    get(target, property: string) {
      if (property in target) return target[property as keyof typeof target];
      if (property === 'getSession' || property === 'getLatestUserAuthorId') return vi.fn(() => undefined);
      if (property === 'getPendingApprovalRepo' || property === 'getDurableRunRepository') return vi.fn(() => undefined);
      if (property === 'getTurnCostRepo') return vi.fn(() => fallbackRepo);
      if (property === 'getTodos') return vi.fn(() => []);
      if (property === 'saveTodos') return vi.fn(() => undefined);
      return vi.fn(() => undefined);
    },
  });
  return { db };
});

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionState.manager,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => databaseState.db,
}));

import type { CanUseToolFn, ToolContext } from '../../../src/host/protocol/tools';
import type { Connector } from '../../../src/host/connectors';
import type { ModelMessage, ModelResponse } from '../../../src/host/model/types';
import { getConfigService } from '../../../src/host/services/core/configService';
import {
  getSessionCommandCenter,
  resetSessionCommandCenterForTest,
} from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { executeDelegateTask } from '../../../src/host/tools/modules/commandCenter/sessionCommandCenter';
import { getConnectorRegistry } from '../../../src/host/connectors';
import { initTaskManager, resetTaskManager } from '../../../src/host/task/TaskManager';
import { ModelRouter } from '../../../src/host/model/modelRouter';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

type ReminderItem = {
  id: string;
  list: string;
  title: string;
  completed: boolean;
  remindAtMs?: number;
};

type ConnectorRun = {
  connector: Connector;
  calls: Array<{ action: string; payload: Record<string, unknown> }>;
  store: ReminderItem[];
};

type ChildCall = {
  name: string;
  args?: Record<string, unknown>;
  result?: { success: boolean; output?: string; error?: string };
};

const UNIQUE_TITLE = 'Pick up the dry cleaning';
const PROMPT = 'remind me tomorrow 9am to pick up the dry cleaning';
const allowTool: CanUseToolFn = async () => ({ allow: true });

let workspaceRoot = '';
let activeRun: ConnectorRun | undefined;
let activeLifecycleEvents: TaskManagerEvent[] = [];
let modelInference: MockInstance;

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => part.text ?? part.thinking ?? part.compaction ?? '').join('\n');
}

function timeoutError(): Error & { killed: true; signal: 'SIGTERM' } {
  return Object.assign(new Error('Command failed: osascript'), { killed: true as const, signal: 'SIGTERM' as const });
}

function tomorrowAtNine(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

function fakeRemindersConnector(listFails: boolean): ConnectorRun {
  const calls: ConnectorRun['calls'] = [];
  const store: ReminderItem[] = [];
  const connector: Connector = {
    id: 'reminders',
    label: 'Reminders (fault injection)',
    capabilities: ['create_reminder', 'list_reminders'],
    getCachedStatus: () => ({ connected: true, readiness: 'ready', capabilities: ['create_reminder', 'list_reminders'] }),
    getStatus: async () => ({ connected: true, readiness: 'ready', capabilities: ['create_reminder', 'list_reminders'] }),
    execute: async (action, payload) => {
      calls.push({ action, payload: { ...payload } });
      if (action === 'create_reminder') {
        store.push({
          id: `fault-${store.length + 1}`,
          list: String(payload.list),
          title: String(payload.title),
          completed: false,
          ...(typeof payload.remind_at_ms === 'number' ? { remindAtMs: payload.remind_at_ms } : {}),
        });
        throw timeoutError();
      }
      if (action === 'list_reminders') {
        if (listFails) throw timeoutError();
        return { data: [...store] };
      }
      throw new Error(`unexpected connector action: ${action}`);
    },
  };
  return { connector, calls, store };
}

function toolContext(sessionId: string): ToolContext {
  return {
    sessionId,
    workingDir: workspaceRoot,
    workspace: workspaceRoot,
    workspaceScope: createWorkspaceScope(`fault-project-${sessionId}`, [{
      sourceId: `fault-source-${sessionId}`,
      path: workspaceRoot,
      role: 'primary',
      access: 'read_write',
    }]),
    abortSignal: new AbortController().signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emit: vi.fn(),
  };
}

function childTranscript(events: Array<{ sessionId: string; event: AgentEvent }>): ChildCall[] {
  const calls: ChildCall[] = [];
  for (const { event } of events) {
    if (event.type === 'tool_call_start') {
      const data = event.data as { name?: unknown; arguments?: unknown };
      if (typeof data.name === 'string') {
        calls.push({
          name: data.name,
          ...(data.arguments && typeof data.arguments === 'object' ? { args: data.arguments as Record<string, unknown> } : {}),
        });
      }
    }
    if (event.type === 'tool_call_end') {
      const data = event.data as { toolCallId?: unknown; success?: unknown; output?: unknown; error?: unknown };
      const prior = calls.at(-1);
      if (!prior || typeof data.toolCallId !== 'string') continue;
      prior.result = {
        success: data.success === true,
        ...(typeof data.output === 'string' ? { output: data.output } : {}),
        ...(typeof data.error === 'string' ? { error: data.error } : {}),
      };
    }
  }
  return calls;
}

async function waitForTerminal(sessionId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const task = getSessionCommandCenter().list(sessionId)[0];
    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`background task did not reach a terminal state: ${JSON.stringify(getSessionCommandCenter().list(sessionId))}`);
}

async function runScenario(
  listFails: boolean,
  sessionId: string,
  events: Array<{ sessionId: string; event: AgentEvent }>,
): Promise<{
  run: ConnectorRun;
  events: Array<{ sessionId: string; event: AgentEvent }>;
  calls: ChildCall[];
  terminalText: string;
  delegateResult: unknown;
}> {
  activeRun = fakeRemindersConnector(listFails);
  getConnectorRegistry().register(activeRun.connector);
  const session: TestSession = {
    id: sessionId,
    title: 'Reminder fault injection',
    messages: [],
    workingDirectory: workspaceRoot,
  };
  sessionState.sessions.set(sessionId, session);

  const delegateResult = await executeDelegateTask({
    title: 'Create a reminder',
    short_name: 'dry cleaning',
    lane_key: `reminder-fault-${sessionId}`,
    submission_key: `reminder-fault-${sessionId}`,
    prompt: PROMPT,
  }, toolContext(sessionId), allowTool);
  await waitForTerminal(sessionId);

  const terminalMessage = [...session.messages].reverse().find((message) => {
    const metadata = message.metadata;
    return metadata !== undefined
      && typeof metadata === 'object'
      && 'backgroundTaskResult' in metadata
      && Boolean(metadata.backgroundTaskResult);
  });
  const terminalText = typeof terminalMessage?.content === 'string' ? terminalMessage.content : '';
  const calls = childTranscript(events);
  const childSessionEvent = activeLifecycleEvents.at(-1);
  const taskId = typeof childSessionEvent?.data === 'object'
    && childSessionEvent.data !== null
    && 'taskId' in childSessionEvent.data
    && typeof childSessionEvent.data.taskId === 'string'
    ? childSessionEvent.data.taskId
    : undefined;
  console.log(`CHILD_SESSION_EVENT ${JSON.stringify({ sessionId, taskId, event: childSessionEvent ?? null })}`);
  console.log(`CHILD_TOOL_CALLS ${JSON.stringify(calls)}`);
  console.log(`STORE_CONTENTS ${JSON.stringify(activeRun.store)}`);
  console.log(`TERMINAL_RESULT ${JSON.stringify(terminalText)}`);
  console.log(`DELEGATE_RESULT ${JSON.stringify(delegateResult)}`);
  return { run: activeRun, events, calls, terminalText, delegateResult };
}

describe('delegated reminders_create timeout fault injection', () => {
  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-reminder-fault-'));
    activeLifecycleEvents = [];
    sessionState.sessions.clear();
    sessionState.manager.addMessageToSession.mockClear();
    sessionState.manager.getSession.mockClear();
    const config = getConfigService();
    const originalGetSettings = config.getSettings.bind(config);
    vi.spyOn(config, 'getSettings').mockImplementation(() => {
      const settings = originalGetSettings();
      return {
        ...settings,
        connectors: { ...settings.connectors, enabledNative: ['reminders'] },
        permissions: {
          ...settings.permissions,
          autoApprove: {
            ...settings.permissions.autoApprove,
            read: true,
            write: true,
            execute: true,
            network: true,
            dangerous: true,
          },
        },
      };
    });
    vi.spyOn(config, 'isDevModeAutoApproveEnabled').mockReturnValue(true);
    vi.stubEnv('CODE_AGENT_MODEL_ENGINE', 'legacy');
    modelInference = vi.spyOn(ModelRouter.prototype, 'inference').mockImplementation(async (
      messages,
      tools,
      config,
      onStream,
    ): Promise<ModelResponse> => {
      const toolResult = [...messages].reverse().find((message) => message.role === 'tool');
      if (toolResult) {
        const resultText = messageText(toolResult);
        onStream?.({ type: 'text', content: resultText });
        onStream?.({ type: 'complete', finishReason: 'stop' });
        return {
          type: 'text',
          content: resultText,
          finishReason: 'stop',
          actualProvider: config.provider,
          actualModel: config.model,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (!tools.some((tool) => tool.name === 'reminders_create')) {
        throw new Error('fault-injection model did not receive reminders_create');
      }
      const toolCall = {
        id: 'fault-reminder-create',
        name: 'reminders_create',
        arguments: {
          list: 'Reminders',
          title: UNIQUE_TITLE,
          remind_at_ms: tomorrowAtNine(),
        },
      };
      onStream?.({ type: 'tool_call_start', toolCall: { index: 0, id: toolCall.id, name: toolCall.name } });
      onStream?.({ type: 'complete', finishReason: 'tool_calls' });
      return {
        type: 'tool_use',
        content: 'Creating the requested reminder through reminders_create.',
        toolCalls: [toolCall],
        finishReason: 'tool_calls',
        actualProvider: config.provider,
        actualModel: config.model,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
  });

  afterEach(async () => {
    modelInference?.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (activeRun) getConnectorRegistry().unregister(activeRun.connector.id);
    activeRun = undefined;
    resetSessionCommandCenterForTest();
    resetTaskManager();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('Scenario A: timeout after create reconciles the delegated child to one reminder', async () => {
    const manager = initTaskManager({ maxConcurrentTasks: 1 });
    manager.on('task_started', (event) => activeLifecycleEvents.push(event));
    const events: Array<{ sessionId: string; event: AgentEvent }> = [];
    manager.initialize({
      configService: getConfigService(),
      onAgentEvent: (sessionId, event) => {
        events.push({ sessionId, event });
        if (event.type === 'permission_request') {
          const requestId = (event.data as { id?: unknown } | null)?.id;
          if (typeof requestId === 'string') {
            setTimeout(() => manager.handlePermissionResponse(sessionId, requestId, 'allow'), 0);
          }
        }
      },
    });
    resetSessionCommandCenterForTest();

    const result = await runScenario(false, 'delegated-reminder-a', events);
    const reminderCalls = result.run.calls.filter((call) => call.action === 'create_reminder');
    const listCalls = result.run.calls.filter((call) => call.action === 'list_reminders');
    const transcript = JSON.stringify({ calls: result.calls, events: result.events, terminal: result.terminalText, delegate: result.delegateResult });
    console.log(`RAW_ASSERTIONS_A ${JSON.stringify({
      titleCount: result.run.store.filter((item) => item.title === UNIQUE_TITLE).length,
      createReminderCalls: reminderCalls.length,
      listReminderCalls: listCalls.length,
      bashCalls: result.calls.filter((call) => call.name === 'Bash').length,
      osascriptDashE: (transcript.match(/osascript -e/g) ?? []).length,
    })}`);
    expect(result.run.store.filter((item) => item.title === UNIQUE_TITLE)).toHaveLength(1);
    expect(reminderCalls).toHaveLength(1);
    expect(listCalls).toHaveLength(1);
    expect(result.calls.filter((call) => call.name === 'Bash')).toHaveLength(0);
    expect(transcript).not.toContain('osascript -e');
    expect(result.calls[0]?.result?.success).toBe(true);
    expect(result.calls[0]?.result?.output).toMatch(/already exists.*not created again/i);
    expect(activeLifecycleEvents).toHaveLength(1);
  });

  it('Scenario B: timeout plus failed listing tells the delegated child to stop and check Reminders', async () => {
    const manager = initTaskManager({ maxConcurrentTasks: 1 });
    manager.on('task_started', (event) => activeLifecycleEvents.push(event));
    const events: Array<{ sessionId: string; event: AgentEvent }> = [];
    manager.initialize({
      configService: getConfigService(),
      onAgentEvent: (sessionId, event) => {
        events.push({ sessionId, event });
        if (event.type === 'permission_request') {
          const requestId = (event.data as { id?: unknown } | null)?.id;
          if (typeof requestId === 'string') {
            setTimeout(() => manager.handlePermissionResponse(sessionId, requestId, 'allow'), 0);
          }
        }
      },
    });
    resetSessionCommandCenterForTest();

    const result = await runScenario(true, 'delegated-reminder-b', events);
    const reminderCalls = result.run.calls.filter((call) => call.action === 'create_reminder');
    const transcript = JSON.stringify(result);
    console.log(`RAW_ASSERTIONS_B ${JSON.stringify({
      createReminderCalls: reminderCalls.length,
      bashCalls: result.calls.filter((call) => call.name === 'Bash').length,
      terminalText: result.terminalText,
    })}`);
    expect(reminderCalls).toHaveLength(1);
    expect(result.calls.filter((call) => call.name === 'Bash')).toHaveLength(0);
    expect(result.calls[0]?.result?.success).toBe(false);
    expect(result.calls[0]?.result?.error).toMatch(/do not retry blindly/i);
    expect(result.calls[0]?.result?.error).toMatch(/check the Reminders list/i);
    expect(result.calls[0]?.result?.error).toMatch(/Do not work around this by running osascript/i);
    expect(result.terminalText).toMatch(/check the Reminders list/i);
    expect(result.terminalText).not.toMatch(/recreate|create .* again/i);
    expect(transcript).not.toContain('osascript -e');
  });
});
