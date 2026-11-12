// Headless listener proof: real cron entry/action/gate/executor/SQLite, scripted model.
// Session/orchestrator factories are test adapters: no desktop bootstrap or model key.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import type { PermissionRequestData } from '../../../src/host/tools/types';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const state = vi.hoisted(() => ({
  db: null as BetterSqlite3.Database | null,
  source: null as EventEmitter | null,
  orchestrator: null as unknown,
  spawn: vi.fn(),
  automationEvent: vi.fn(async () => true),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => state.db }),
}));
vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => state.source,
}));
vi.mock('../../../src/host/services/infra/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { createLogger: () => logger, logger, default: logger };
});
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({ ui: { language: 'zh' } }),
  }),
}));
vi.mock('../../../src/host/services/serviceRegistry', () => ({
  getServiceRegistry: () => ({ register: vi.fn() }),
}));
vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    recordCreated: vi.fn(async () => undefined), recordEvent: state.automationEvent,
    getBySourceRef: () => null, upsert: vi.fn(),
  }),
}));
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyTaskComplete: vi.fn(), notifyNeedsInput: vi.fn() },
}));
vi.mock('../../../src/host/services/wake/wakeService', () => ({
  getWakeService: () => ({ onJobCompleted: vi.fn(async () => undefined), onEvent: vi.fn(async () => undefined) }),
}));
vi.mock('../../../src/host/cron/cronAgentSession', () => ({
  createCronAgentSession: async (_definition: unknown, _action: unknown, executionId: string) => {
    const id = `session-${executionId}`;
    state.db!.prepare(`INSERT INTO sessions
      (id, title, model_provider, model_name, read_only, created_at, updated_at)
      VALUES (?, 'scripted listener', 'scripted', 'scripted', 1, ?, ?)`)
      .run(id, Date.now(), Date.now());
    return { id, workingDirectory: undefined };
  },
}));
vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => state.orchestrator,
    setWorkingDirectory: vi.fn(), cleanup: vi.fn(),
  }),
}));
// This is another model call (the optional Bash description), never a live provider.
vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));
// Count the actual process boundary, keeping resolver, Bash handler and foreground runner real.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: (...args: unknown[]) => state.spawn(...args),
}));

import { CronService } from '../../../src/host/cron/cronService';
import { CronEventTrigger } from '../../../src/host/cron/cronEventTrigger';
import * as observe from '../../../src/host/cron/cronObserveMode';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { createLogger } from '../../../src/host/services/infra/logger';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { loadCronEventDecisions, sqliteCronEventDecisionStore } from '../../../src/host/cron/cronEventDecisionLedger';
import type { ChannelMessage } from '../../../src/shared/contract/channel';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { localizeDecisionText } from '../../../src/shared/cronEventDecisionText';

const RULE = 'if the message contains RR51-PING reply RR51-PONG 收到';
const MESSAGE_ID = 'om_rr51_1';
const COMMAND = `lark-cli im +messages-reply --message-id ${MESSAGE_ID} --text "RR51-PONG 收到"`;
const SELECT_DECISIONS = 'SELECT * FROM cron_event_decisions WHERE job_id = ?';
const logger = createLogger('CronObserveModeFeishuListenTest');

function proof(line: string) {
  process.stdout.write(`${line}\n`);
}

let service: CronService;
let workspace: string;
let job: CronJobDefinition;
let executor: ToolExecutor;
let requestPermission: ReturnType<typeof vi.fn<(request: PermissionRequestData) => Promise<boolean>>>;
let messages: Array<{ role: string; content: string }>;
let runEvents: Array<{ type: string; data: unknown }>;
let enterObserve: MockInstance<typeof observe.enterObserveModeForCronRun>;

function decisionRows() {
  return state.db!.prepare(SELECT_DECISIONS).all(job.id);
}

function counters(label: string) {
  const snapshot = {
    approvalRequests: requestPermission.mock.calls.length,
    approvalEntries: runEvents.filter((event) => /permission|approval/i.test(event.type)),
    sends: state.spawn.mock.calls.length,
  };
  proof(`[${label}] ${JSON.stringify(snapshot)}`);
  return snapshot;
}

beforeEach(async () => {
  resetPermissionModeManager();
  workspace = mkdtempSync(path.join(tmpdir(), 'cron-feishu-listen-'));
  state.db = new Database(':memory:');
  state.db.pragma('foreign_keys = ON');
  applySchema(state.db, logger);
  state.source = new EventEmitter();
  state.spawn.mockReset();
  state.spawn.mockImplementation((command: string) => {
    expect(command).toContain('lark-cli im +messages-reply');
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn(),
    });
    queueMicrotask(() => {
      child.stdout.write('{"message_id":"om_reply_control"}');
      child.emit('close', 0, null);
    });
    return child;
  });
  state.automationEvent.mockClear();
  messages = [];
  runEvents = [];
  requestPermission = vi.fn(async (request: PermissionRequestData) => {
    runEvents.push({ type: 'permission_request', data: request });
    return false; // Never grant a mutated observe run.
  });
  getProtocolRegistry();
  getToolCache().clear();
  executor = new ToolExecutor({ workingDirectory: workspace, requestPermission, executionTopology: 'async_agent' });
  executor.setAuditEnabled(false);
  enterObserve = vi.spyOn(observe, 'enterObserveModeForCronRun'); // Call through, never replace the gate.
  state.orchestrator = {
    setExecutionTopology: (topology: string) => expect(topology).toBe('async_agent'),
    getMessages: () => messages,
    sendMessage: async (prompt: string) => {
      expect(prompt).toContain(RULE);
      expect(prompt).toContain('RR51-PING 群监听测试');
      expect(prompt).toContain(MESSAGE_ID);
      const sessionId = service.getJobExecutions(job.id)[0].sessionId!;
      // N-TRIGGER-OBSERVE-ACTION-CONTRACT-DESIGN：签名扩到 5 参（store 缺省 + 群名提示）。
      expect(enterObserve).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), sessionId, expect.any(String), undefined, { chatName: undefined });
      proof(`[PATH] executeCronAgentAction -> enterObserveModeForCronRun session=${sessionId} mode=${job.actionMode}`);
      messages.push({ role: 'user', content: prompt });
      const result = await executor.execute('Bash', { command: COMMAND }, {
        sessionId, emitEvent: (type, data) => runEvents.push({ type, data }),
      });
      if (result.metadata?.code === 'OBSERVE_MODE_RECORDED') {
        proof(`[PATH] enterObserveModeForCronRun registered session=${sessionId}; real ToolExecutor returned OBSERVE_MODE_RECORDED`);
      }
      messages.push({ role: 'tool', content: JSON.stringify(result) });
      messages.push({ role: 'assistant', content:
        `<cron_event_decision id="${MESSAGE_ID}" action="act" rule="${RULE}">消息包含 RR51-PING</cron_event_decision>`,
      });
    },
  };
  service = new CronService();
  const start = vi.spyOn(CronEventTrigger.prototype, 'start');
  await service.initialize();
  expect(start).toHaveBeenCalledOnce();
  job = await service.createJob({
    name: '飞书群消息观察', scheduleType: 'event',
    schedule: { type: 'event', source: 'channel', accountId: 'feishu-test', chatId: 'oc_rr51', eventName: 'message', batchWindowSec: 1 },
    action: { type: 'agent', agentType: 'default', prompt: RULE },
    maxRunBudget: 0.5, enabled: true,
  });
  expect(job.actionMode).toBe('observe');
  // Positive query control before any absence/presence assertion; keep it in the same job.
  sqliteCronEventDecisionStore.record([{
    jobId: job.id, kind: 'event', eventId: 'query-control', decision: 'ignored', reason: '查询对照行',
  }]);
  const control = decisionRows();
  proof(`[CONTROL ${SELECT_DECISIONS}] ${JSON.stringify(control)}`);
  expect(control).toEqual([expect.objectContaining({ job_id: job.id, event_id: 'query-control', reason: '查询对照行' })]);
  expect(loadCronEventDecisions(job.id)).toEqual([expect.objectContaining({ eventId: 'query-control' })]);
});

afterEach(async () => {
  await service?.shutdown();
  vi.restoreAllMocks();
  vi.useRealTimers();
  getToolCache().clear();
  resetPermissionModeManager();
  state.db?.close();
  state.db = null;
  rmSync(workspace, { recursive: true, force: true });
});

async function injectListenMessage() {
  const handlers = state.source!.listeners('listen_message');
  expect(handlers).toHaveLength(1);
  expect(handlers[0].name).toBe('handleChannelListenMessage');
  const message: ChannelMessage = {
    id: MESSAGE_ID, channelId: 'feishu', sender: { id: 'sender-test', name: '测试成员' },
    context: { chatId: 'oc_rr51', chatType: 'group' },
    content: 'RR51-PING 群监听测试', timestamp: Date.now(), ingressAuth: 'guest',
  };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  state.source!.emit('listen_message', 'feishu-test', message);
  proof(`[PATH] listen_message -> ${handlers[0].name} message=${message.id}`);
  await vi.advanceTimersByTimeAsync(1000);
  vi.useRealTimers();
}

async function waitForSettlement() {
  await vi.waitFor(() => {
    expect(loadCronEventDecisions(job.id).find((row) => row.eventId === MESSAGE_ID)).toBeDefined();
  });
  const execution = service.getJobExecutions(job.id)[0];
  expect(execution.status).toBe('completed');
  expect(execution.trigger).toMatchObject({ listen: true, eventIds: [MESSAGE_ID], eventCount: 1 });
  const rawRun = state.db!.prepare('SELECT * FROM cron_executions WHERE job_id = ?').all(job.id);
  expect(rawRun).toEqual([expect.objectContaining({
    id: execution.id, session_id: execution.sessionId, status: 'completed',
  })]);
  proof(`[RUN] ${JSON.stringify(rawRun)}`);
  proof(`[ROWS ${SELECT_DECISIONS}] ${JSON.stringify(decisionRows())}`);
  proof(`[RUN EVENTS] ${JSON.stringify(runEvents)}`);
  return execution;
}

describe('Feishu listen_message through production cron observe gate', () => {
  it('observe: no approval, no send, exactly one would_act action and an event rule', async () => {
    await injectListenMessage();
    const execution = await waitForSettlement();
    const snapshot = counters('OBSERVE');
    expect(snapshot.approvalRequests).toBe(0);
    expect(snapshot.approvalEntries).toEqual([]);
    expect(snapshot.sends).toBe(0);
    expect(JSON.stringify(execution)).not.toMatch(/permission_request|pending_approval|awaiting_approval/);
    expect(messages.find((message) => message.role === 'tool')?.content).toContain('OBSERVE_MODE_RECORDED');
    const rows = loadCronEventDecisions(job.id);
    expect(rows.filter((row) => row.kind === 'action')).toEqual([expect.objectContaining({
      decision: 'would_act', tool: '飞书 回复消息', target: MESSAGE_ID, summary: 'RR51-PONG 收到', runId: execution.id,
    })]);
    expect(rows.find((row) => row.eventId === MESSAGE_ID)).toMatchObject({
      kind: 'event', decision: 'would_act', matchedRule: RULE, runId: execution.id,
    });
    const action = rows.find((row) => row.kind === 'action')!;
    expect(`${action.tool} ${action.summary}`).not.toMatch(/Bash|lark-cli|would_act/);
    const localizedReason = localizeDecisionText(action.reason, 'zh');
    proof(`[LOCALIZED ACTION] ${JSON.stringify({ stored: action.reason, zh: localizedReason })}`);
    expect(localizedReason).not.toMatch(/intercepted|observe mode|lark-cli|Bash/i);
    expect(localizedReason).toContain('飞书 回复消息');
    expect(localizedReason).toBe('仅观察模式：已拦下「飞书 回复消息」，没有真的发出去');
    expect(action.reason).toBe('outbound action 飞书 回复消息 intercepted in observe mode');
  });

  it('auto: the same listener/message asks ToolExecutor approval, sends zero before grant, no would_act action', async () => {
    job = (await service.setEventActionMode(job.id, 'auto'))!;
    expect(job.actionMode).toBe('auto');
    expect(state.automationEvent).toHaveBeenCalled();
    expect(state.db!.prepare('SELECT action_mode FROM cron_jobs WHERE id = ?').get(job.id)).toEqual({ action_mode: 'auto' });
    let deny: ((approved: boolean) => void) | undefined;
    requestPermission.mockImplementation((request) => {
      runEvents.push({ type: 'permission_request', data: request });
      return new Promise<boolean>((resolve) => { deny = resolve; });
    });
    try {
      await injectListenMessage();
      await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledOnce());
      proof(`[AUTO APPROVAL CALL] ${JSON.stringify(requestPermission.mock.calls)}`);
      expect(requestPermission.mock.calls[0][0]).toMatchObject({ details: { command: COMMAND } });
      expect(service.getJobExecutions(job.id)[0].status).toBe('running');
      expect(counters('AUTO BEFORE APPROVAL')).toMatchObject({ approvalRequests: 1, sends: 0 });
      expect(loadCronEventDecisions(job.id).filter((row) => row.kind === 'action' && row.decision === 'would_act')).toEqual([]);
    } finally {
      deny?.(false); // Cleanly settle the real run without ever granting the send.
    }
    await waitForSettlement();
    expect(state.spawn).not.toHaveBeenCalled();
    expect(loadCronEventDecisions(job.id).filter((row) => row.kind === 'action')).toEqual([]);
  });

  it('send counter control: approved real Bash reaches the mocked process exactly once', async () => {
    requestPermission.mockResolvedValue(true);
    const result = await executor.execute('Bash', { command: COMMAND }, { sessionId: 'send-counter-control' });
    proof(`[SEND COUNTER CONTROL] ${JSON.stringify({ success: result.success, sends: state.spawn.mock.calls.length })}`);
    expect(result.success).toBe(true);
    expect(state.spawn).toHaveBeenCalledOnce();
  });
});
