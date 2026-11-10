import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message, Session } from '../../../../src/shared/contract';
import type { ConfigService } from '../../../../src/host/services/core/configService';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { AgentOrchestrator } from '../../../../src/host/agent/agentOrchestrator';
import { ContextAssembly } from '../../../../src/host/agent/runtime/contextAssembly';
import { ConversationRuntime } from '../../../../src/host/agent/runtime/conversationRuntime';
import { StreamHandler } from '../../../../src/host/agent/runtime/streamHandler';
import { getApplicationRunRegistry, resetApplicationRunRegistryForTests } from '../../../../src/host/app/applicationRunRegistry';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { SessionRepository } from '../../../../src/host/services/core/repositories/SessionRepository';
import { applySchema } from '../../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../../src/host/services/core/database/migrations';
import { applyConversationBranchSchema } from '../../../../src/host/services/core/database/schemaConversationBranch';
import { getLangfuseService } from '../../../../src/host/services';
import { DEFAULT_SETTINGS } from '../../../../src/host/services/core/configDefaults';
import { settlePrimaryRunSessionStatus } from '../../../../src/host/task/backgroundTaskTerminal';
import { ModelRouter } from '../../../../src/host/model/modelRouter';

const store = vi.hoisted(() => ({
  sessions: undefined as SessionRepository | undefined,
}));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getCurrentSessionId: () => 'cancel-session',
    getSession: async (id: string) => store.sessions?.getSession(id),
    addMessageToSession: async (id: string, message: Message) => store.sessions?.addMessage(id, message),
    updateSession: async (id: string, updates: Partial<Session>) => store.sessions?.updateSession(id, updates),
    getSessionMetadata: () => undefined,
    getTodos: async () => [],
    saveTodos: async () => {},
  }),
}));
vi.mock('../../../../src/host/agent/agentRequirementsAnalyzer', () => ({
  getAgentRequirementsAnalyzer: () => ({ analyze: async () => ({ needsAutoAgent: false }) }),
}));
vi.mock('../../../../src/host/agent/orchestrator/agentRoutingResolver', () => ({ resolveAgentRouting: async () => null }));
vi.mock('../../../../src/host/services/wake/userReturn', () => ({ cancelTimeWakesOnUserReturn: async () => {} }));

describe('AgentOrchestrator Stop before first model packet', () => {
  let root: string;
  let db: Database.Database;
  let runs: DurableRunRepository;
  let orchestrator: AgentOrchestrator;
  let runtime: RuntimeContext;
  let events: AgentEvent[];
  let signal: AbortSignal | undefined;
  let onStream: Parameters<ModelRouter['inference']>[3];
  let requestStarted: boolean;
  let writes: Promise<void>[];

  beforeEach(() => {
    vi.stubEnv('CODE_AGENT_MODEL_ENGINE', 'legacy');
    vi.stubEnv('EVAL_DISABLED', 'true');
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cancel-first-packet-')));
    db = new Database(path.join(root, 'test.db'));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    applySchema(db, logger as never);
    applySessionsMigrations(db, logger as never);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    store.sessions = new SessionRepository(db);
    store.sessions.createSession({ id: 'cancel-session', title: 'Meeting summary', modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' }, workingDirectory: root, createdAt: 1, updatedAt: 1, status: 'running' } as Session);
    runs = new DurableRunRepository(db);
    runs.migrate();
    const registry = getApplicationRunRegistry();
    registry.configureDurableKernel(new DurableRunKernel({ stores: runs, ownerId: 'test-host', processInstanceId: 'test-process', leaseDurationMs: 60000 }));
    events = []; writes = []; requestStarted = false; signal = undefined;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.models = { ...settings.models, default: 'xiaomi', providers: { xiaomi: { enabled: true, apiKey: 'fixture-key', model: 'mimo-v2.6-flash' } } };
    const config = { getSettings: () => settings, getApiKey: () => 'fixture-key', getServiceApiKey: () => '', isDevModeAutoApproveEnabled: () => false } as unknown as ConfigService;
    orchestrator = new AgentOrchestrator({ configService: config, runRegistry: registry, hasApprovalUi: () => false, getHomeDir: () => root, onEvent: (event) => {
      events.push(event);
      if (event.type === 'agent_cancelled' || event.type === 'agent_complete') writes.push(settlePrimaryRunSessionStatus('cancel-session', event.type, new Map()));
    } });
    orchestrator.setSessionId('cancel-session');
    orchestrator.setWorkingDirectory(root, { syncWorkspaceServices: false });
    // Isolate optional startup context sources, not the loop/control/finalizer layers.
    vi.spyOn(ConversationRuntime.prototype, 'initializeRun').mockImplementation(async function (this: ConversationRuntime, prompt) {
      runtime = (this as unknown as { ctx: RuntimeContext }).ctx;
      runtime.turn.beginRun(prompt);
      return { langfuse: getLangfuseService(), isSimpleTask: true, genNum: 8 };
    });
    vi.spyOn(StreamHandler.prototype, 'injectContextualMemory').mockResolvedValue(undefined);
    vi.spyOn(StreamHandler.prototype, 'injectPlanContext').mockResolvedValue(undefined);
    // Provider boundary deliberately ignores abort: Stop must not await its settlement.
    vi.spyOn(ModelRouter.prototype, 'inference').mockImplementation((_messages, _tools, _config, stream, abort) => {
      signal = abort; onStream = stream; requestStarted = true;
      return new Promise(() => {});
    });
  });

  afterEach(async () => {
    await Promise.all(writes);
    await orchestrator.drainWorkspaceServices();
    resetApplicationRunRegistryForTests();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    db.close(); rmSync(root, { recursive: true, force: true });
    store.sessions = undefined;
  });

  it.each([false, true])('never-resolving inference (first packet=%s): three Stops settle once within 3 seconds', async (firstPacket) => {
    const run = orchestrator.sendMessage('Read the meeting notes and write a one-page summary.', undefined, { mode: 'normal', disableAutoAgent: true });
    await vi.waitFor(() => expect(requestStarted).toBe(true));
    if (firstPacket) await onStream?.({ type: 'text', content: '已读完会议记录。' });
    expect(runtime.turn.lastStreamedContent).toBe(firstPacket ? '已读完会议记录。' : '');
    expect(events.some((event) => event.type === 'stream_tool_call_start')).toBe(false);
    const stoppedAt = Date.now();
    const stopped = Promise.all([orchestrator.cancel('user'), orchestrator.cancel('user'), orchestrator.cancel('user')]);
    try {
      await vi.waitFor(() => expect(runtime.control.isSettled).toBe(true), { timeout: 2500 });
    } finally {
      console.log('STOP_STATE', JSON.stringify({
        isSettled: runtime.control.isSettled, aborted: signal?.aborted,
        streamedContent: runtime.turn.lastStreamedContent,
        sessions: db.prepare('select id,status from sessions').all(),
        durable: db.prepare('select run_id,status,envelope_json from durable_runs').all(),
        messages: db.prepare('select role,content from messages order by rowid').all(),
        terminalEvents: events.filter((event) => event.type === 'agent_cancelled'),
      }));
    }
    await stopped; await run; await Promise.all(writes);
    expect(Date.now() - stoppedAt).toBeLessThan(3000);
    expect(signal?.aborted).toBe(true);
    expect(store.sessions?.getSession('cancel-session')?.status).toBe('interrupted');
    const rows = db.prepare('select status,envelope_json from durable_runs').all() as Array<{ status: string; envelope_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.envelope_json ?? '{}')).toMatchObject({ status: 'waiting', interruptCause: 'user_stop', pendingOperations: [expect.objectContaining({ status: 'abandoned' })] });
    expect(store.sessions?.getMessages('cancel-session').filter((m) => m.content.includes('[cancelled]'))).toHaveLength(1);
    const eventCount = events.length;
    await onStream?.({ type: 'text', content: 'late model output' });
    expect(events).toHaveLength(eventCount);
    expect(runtime.turn.lastStreamedContent).toBe('');
    await orchestrator.cancel('user');
    expect(store.sessions?.getMessages('cancel-session').filter((m) => m.content.includes('[cancelled]'))).toHaveLength(1);
  });

  it('Stop during request assembly aborts a controller attached later without dispatching the model', async () => {
    let assemblyStarted = false;
    let releaseAssembly = () => {};
    const assemblyGate = new Promise<void>((resolve) => { releaseAssembly = resolve; });
    const build = ContextAssembly.prototype.buildModelMessages;
    vi.spyOn(ContextAssembly.prototype, 'buildModelMessages').mockImplementation(async function (this: ContextAssembly) {
      assemblyStarted = true;
      await assemblyGate;
      return build.call(this);
    });
    const run = orchestrator.sendMessage('Summarize the meeting notes.', undefined, { mode: 'normal', disableAutoAgent: true });
    await vi.waitFor(() => expect(assemblyStarted).toBe(true));
    expect(runtime.control.abortController).toBeNull();
    const stop = orchestrator.cancel('user');
    await vi.waitFor(() => expect(runtime.control.isCancelled).toBe(true));
    releaseAssembly();
    await stop; await run; await Promise.all(writes);
    expect(ModelRouter.prototype.inference).not.toHaveBeenCalled();
    expect(runtime.control.isSettled).toBe(true);
    expect(store.sessions?.getSession('cancel-session')?.status).toBe('interrupted');
    expect(store.sessions?.getMessages('cancel-session').filter((m) => m.content.includes('[cancelled]'))).toHaveLength(1);
  });

  it('a fast model finishes normally and Stop after settlement adds no marker', async () => {
    vi.mocked(ModelRouter.prototype.inference).mockImplementation(async (_messages, _tools, _config, stream) => {
      await stream?.({ type: 'text', content: '会议摘要：周三完成反馈归类，下周一评审改进计划。' });
      return { type: 'text', content: '会议摘要：周三完成反馈归类，下周一评审改进计划。' };
    });
    await orchestrator.sendMessage('Summarize these meeting notes in one sentence.', undefined, { mode: 'normal', disableAutoAgent: true });
    await Promise.all(writes);
    expect(runtime.control.isSettled).toBe(true);
    expect(store.sessions?.getSession('cancel-session')?.status).toBe('completed');
    expect(db.prepare('select status from durable_runs').all()).toEqual([{ status: 'completed' }]);
    await orchestrator.cancel('user');
    expect(store.sessions?.getMessages('cancel-session').some((m) => m.content.includes('[cancelled]'))).toBe(false);
  });
});
