import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

vi.mock('../../../src/host/services/core/database/nativeLoader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/core/database/nativeLoader')>();
  return {
    ...actual,
    loadBetterSqlite3: () => Database,
  };
});

import { getMCPClient, type MCPClient } from '../../../src/host/mcp/mcpClient';
import { CUA_DRIVER_SERVER_NAME } from '../../../src/host/mcp/types';
import { CuaMcpDriverPort } from '../../../src/host/mcp/cuaMcpDriverPort';
import { CuaStateAdapter } from '../../../src/host/mcp/cuaStateAdapter';
import { CuaStatefulComputerUseHandler } from '../../../src/host/plugins/builtin/computerUse/cuaStatefulComputerUse';
import { cuaStatefulComputerUseSchema } from '../../../src/host/plugins/builtin/computerUse/cuaStatefulComputerUse.schema';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { getToolLedgerSink, setToolLedgerSink, type ToolLedgerSink } from '../../../src/host/tools/toolLedgerSink';
import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { ToolExecutionEventRepository } from '../../../src/host/services/core/repositories/ToolExecutionEventRepository';
import { bindAppGrantDatabase, mintAppGrantStanding } from '../../../src/host/permissions/appGrantStore';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import {
  SurfaceExecutionRuntime,
  resetSurfaceExecutionRuntimeForTests,
} from '../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { SurfaceConversationProjectionService } from '../../../src/host/services/surfaceExecution/SurfaceConversationProjectionService';
import { registerSurfaceExecutionHandlers } from '../../../src/host/ipc/surfaceExecution.ipc';
import { createDomainRouter } from '../../../src/web/routes/domain';
import type { WebRouteHandler } from '../../../src/web/routes/routeTypes';
import { createToolExecutionWatchdog } from '../../../src/host/agent/runtime/toolExecutionTimeout';
import {
  createHumanWaitBoundTimeout,
  isHumanWaitActive,
} from '../../../src/host/services/infra/timeoutController';
import { clearApprovalWait, getApprovalWaitMs } from '../../../src/host/tools/toolExecutionTelemetry';
import { getToolExecutionTimeoutMs } from '../../../src/shared/constants/timeouts';
import type { AgentEvent, SessionWithMessages } from '../../../src/shared/contract';

const FAKE_CUA_DRIVER = path.resolve(__dirname, '../../fixtures/mcp/fake-cua-driver.mjs');

const EXPECTED_SCREEN_TOUCHED_NOTE =
  'A human used this screen since your last look, so it may have changed. Observe again before acting.';

interface DriverLogEntry {
  ts: number;
  iso: string;
  pid: number;
  toolName: string;
  args: Record<string, unknown>;
}

function readDriverLog(jsonlPath: string): DriverLogEntry[] {
  if (!fs.existsSync(jsonlPath)) return [];
  return fs
    .readFileSync(jsonlPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DriverLogEntry);
}

const INPUT_TOOL_NAMES = new Set([
  'click',
  'double_click',
  'right_click',
  'set_value',
  'type_text',
  'press_key',
  'hotkey',
  'scroll',
  'drag',
]);

describe('N-CUA-TAKEOVER-RESUME-FU1 headless ToolExecutor + HTTP control bridge + SQLite + stdio fake cua-driver', () => {
  let tempDir: string;
  let workspaceDir: string;
  let driverJsonlPath: string;
  let lockFilePath: string;
  let dbService: DatabaseService;
  let toolEventRepo: ToolExecutionEventRepository;
  let previousLedgerSink: ToolLedgerSink;
  let mcpClient: MCPClient;
  let httpServer: http.Server | undefined;
  let httpPort = 0;
  let projectionService: SurfaceConversationProjectionService | undefined;
  let runRegistry: RunRegistry;
  let surfaceRuntime: SurfaceExecutionRuntime;
  let activeRunIds: string[] = [];
  const prevLockEnv = process.env.CODE_AGENT_CU_LOCK_PATH;
  const prevStateV2Env = process.env.CODE_AGENT_CUA_STATE_V2;
  const prevEnableCuaEnv = process.env.CODE_AGENT_ENABLE_CUA;

  beforeEach(async () => {
    activeRunIds = [];
    resetDecisionHistory();
    resetPermissionModeManager();
    getPermissionModeManager().setMode('default', true);
    resetProtocolRegistry();
    resetSurfaceExecutionRuntimeForTests();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-cua-takeover-fu1-'));
    workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    driverJsonlPath = path.join(tempDir, 'fake-cua-driver.jsonl');
    lockFilePath = path.join(tempDir, 'computer-use.lock');

    process.env.CODE_AGENT_CU_LOCK_PATH = lockFilePath;
    process.env.CODE_AGENT_ENABLE_CUA = '1';
    process.env.CODE_AGENT_CUA_STATE_V2 = '1';

    // Real SQLite database via production DatabaseService
    dbService = new DatabaseService(tempDir);
    await dbService.initialize();
    const rawDb = dbService.getDb();
    if (!rawDb) throw new Error('Expected initialized SQLite database');
    toolEventRepo = new ToolExecutionEventRepository(rawDb);
    bindAppGrantDatabase(rawDb, true);
    mintAppGrantStanding({ name: 'Notes' }, 1);

    previousLedgerSink = getToolLedgerSink();
    setToolLedgerSink({
      appendPermissionDecision: (input) => dbService.appendPermissionDecision(input),
      appendToolExecutionBegin: (input) => dbService.appendToolExecutionBegin(input),
      appendToolExecutionComplete: (input) => dbService.appendToolExecutionComplete(input),
    });

    // Real stdio MCP server subprocess backing CuaMcpDriverPort
    mcpClient = getMCPClient();
    await mcpClient.disconnectAll();
    await mcpClient.removeServer(CUA_DRIVER_SERVER_NAME).catch(() => undefined);
    mcpClient.addServer({
      name: CUA_DRIVER_SERVER_NAME,
      type: 'stdio',
      command: process.execPath,
      args: [FAKE_CUA_DRIVER],
      env: { FAKE_CUA_DRIVER_JSONL: driverJsonlPath },
      enabled: true,
      lazyLoad: false,
    });
    await mcpClient.ensureConnected(CUA_DRIVER_SERVER_NAME);

    // Production SurfaceExecutionRuntime + CuaStatefulComputerUseHandler registered in ProtocolRegistry
    runRegistry = new RunRegistry();
    const runtime = new SurfaceExecutionRuntime({ runRegistry });
    surfaceRuntime = runtime;
    const adapter = new CuaStateAdapter(new CuaMcpDriverPort());
    const handler = new CuaStatefulComputerUseHandler(adapter, runtime);
    getProtocolRegistry().register(cuaStatefulComputerUseSchema, async () => ({
      schema: cuaStatefulComputerUseSchema,
      createHandler: () => handler,
    }));

    // Production HTTP control bridge: createDomainRouter + registerSurfaceExecutionHandlers + SurfaceConversationProjectionService
    projectionService = new SurfaceConversationProjectionService({
      runtime,
      sessionStore: {
        async getSession(conversationId: string): Promise<SessionWithMessages | null> {
          const stored = dbService.getSession(conversationId);
          if (!stored) return null;
          return {
            id: stored.id,
            title: stored.title,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            messageCount: 0,
            modelConfig: stored.modelConfig,
            workingDirectory: stored.workingDirectory,
            metadata: stored.metadata,
            messages: [],
          };
        },
        async patchSessionMetadata(conversationId, patch, options) {
          return dbService.patchSessionMetadata(conversationId, patch, options);
        },
      },
    });

    const handlers = new Map<string, WebRouteHandler>();
    registerSurfaceExecutionHandlers(
      { handle: (channel: string, fn: WebRouteHandler) => handlers.set(channel, fn) } as never,
      () => projectionService as never,
      () => ({
        start: async (req: { surfaceSessionId: string }) => ({ version: 1 as const, surfaceSessionId: req.surfaceSessionId, streaming: true }),
        stop: async (surfaceSessionId: string) => ({ version: 1 as const, surfaceSessionId, streaming: false }),
      }),
    );

    const app = express();
    app.use(express.json());
    app.use('/api', createDomainRouter({
      handlers,
      logger: { warn: () => {}, error: () => {} },
    }));
    httpServer = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP server address');
    httpPort = addr.port;
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const runId of activeRunIds) {
      runRegistry?.unregister(runId);
    }
    if (httpServer) {
      await new Promise<void>((resolve, reject) =>
        httpServer?.close((err) => (err ? reject(err) : resolve())),
      );
      httpServer = undefined;
    }
    if (projectionService) {
      await projectionService.flushPersistence();
      projectionService.dispose();
      projectionService = undefined;
    }
    if (mcpClient) {
      await mcpClient.disconnectAll();
      await mcpClient.removeServer(CUA_DRIVER_SERVER_NAME).catch(() => undefined);
    }
    if (previousLedgerSink) {
      setToolLedgerSink(previousLedgerSink);
    }
    dbService?.close();
    resetProtocolRegistry();
    resetSurfaceExecutionRuntimeForTests();
    resetPermissionModeManager();
    if (prevLockEnv === undefined) delete process.env.CODE_AGENT_CU_LOCK_PATH;
    else process.env.CODE_AGENT_CU_LOCK_PATH = prevLockEnv;
    if (prevStateV2Env === undefined) delete process.env.CODE_AGENT_CUA_STATE_V2;
    else process.env.CODE_AGENT_CUA_STATE_V2 = prevStateV2Env;
    if (prevEnableCuaEnv === undefined) delete process.env.CODE_AGENT_ENABLE_CUA;
    else process.env.CODE_AGENT_ENABLE_CUA = prevEnableCuaEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function startConversationAndRun(conversationId: string, runId: string) {
    const now = Date.now();
    dbService.createSessionWithId(conversationId, {
      title: 'Weekly report in Notes',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
      workingDirectory: workspaceDir,
      createdAt: now,
      updatedAt: now,
    });
    runRegistry.start({ runId, sessionId: conversationId, workspace: workspaceDir });
    activeRunIds.push(runId);
    const executor = new ToolExecutor({
      workingDirectory: workspaceDir,
      requestPermission: async () => ({ approved: true, approvalSource: 'user' as const }),
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  async function postSurfaceBridge<T = unknown>(
    action: 'getSnapshot' | 'control',
    payload: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/domain/surfaceExecution/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: `req-${action}-${Date.now()}`,
        payload,
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { success: boolean; data?: T; error?: { code: string; message: string } };
  }

  async function seedObservedViaExecutor(
    executor: ToolExecutor,
    conversationId: string,
    runId: string,
  ): Promise<{ stateId: string; surfaceSessionId: string }> {
    const listed = await executor.execute(
      'computer_use',
      { operation: 'list_roots', onScreenOnly: true },
      {
        sessionId: conversationId,
        runId,
        agentId: 'main',
        currentToolCallId: `${runId}:list-roots`,
      },
    );
    expect(listed.success).toBe(true);

    const observed = await executor.execute(
      'computer_use',
      { operation: 'observe', targetApp: 'Notes', target: { pid: 42, windowId: 7 } },
      {
        sessionId: conversationId,
        runId,
        agentId: 'main',
        currentToolCallId: `${runId}:observe-1`,
      },
    );
    expect(observed.success).toBe(true);
    const parsed = JSON.parse(String(observed.output)) as { state: { stateId: string } };
    const snap = await postSurfaceBridge<{
      sessions: Array<{ session: { sessionId: string; state: string } }>;
    }>('getSnapshot', { version: 1, conversationId });
    expect(snap.success).toBe(true);
    const surfaceSessionId = snap.data?.sessions[0]?.session.sessionId ?? '';
    expect(surfaceSessionId).toMatch(/^surface_/);
    return { stateId: parsed.state.stateId, surfaceSessionId };
  }

  it('① & ② holds computer_use act during HTTP takeover with 0 MCP input calls & 0 completed act SQLite rows, rejects stale stateId with human-touched note + SURFACE_STATE_STALE on HTTP resume, then re-observes and acts cleanly', async () => {
    const conversationId = 'conv-it-1';
    const runId = 'run-it-1';
    const executor = startConversationAndRun(conversationId, runId);
    const { stateId: preTakeoverStateId, surfaceSessionId } = await seedObservedViaExecutor(
      executor,
      conversationId,
      runId,
    );

    const takeoverAt = Date.now();
    const takeoverRes = await postSurfaceBridge<{
      snapshot: { sessions: Array<{ session: { state: string } }> };
    }>('control', {
      version: 1,
      conversationId,
      surfaceSessionId,
      action: 'takeover',
      reason: 'User handling iCloud login dialog',
    });
    expect(takeoverRes.success).toBe(true);
    expect(takeoverRes.data?.snapshot.sessions[0]?.session.state).toBe('waiting_human');

    const driverCallsAtTakeover = readDriverLog(driverJsonlPath);
    expect(driverCallsAtTakeover.filter((c) => INPUT_TOOL_NAMES.has(c.toolName))).toHaveLength(0);

    let actSettled = false;
    const heldActToolCallId = `${runId}:act-held`;
    const pendingAct = executor.execute(
      'computer_use',
      {
        operation: 'act',
        targetApp: 'Notes',
        stateId: preTakeoverStateId,
        mutation: { kind: 'click', elementRef: 'e2' },
      },
      {
        sessionId: conversationId,
        runId,
        agentId: 'main',
        currentToolCallId: heldActToolCallId,
      },
    ).then((res) => {
      actSettled = true;
      return res;
    });

    await new Promise((r) => setTimeout(r, 350));

    // ① During waiting_human: act is held, 0 MCP calls after takeover, no completed act row in SQLite
    expect(actSettled).toBe(false);
    const driverCallsWhileWaiting = readDriverLog(driverJsonlPath).filter((c) => c.ts >= takeoverAt);
    expect(driverCallsWhileWaiting).toHaveLength(0);
    const dbEventsWhileWaiting = toolEventRepo.getBySession(conversationId);
    const beginByExecIdWhileWaiting = new Map(
      dbEventsWhileWaiting.filter((r) => r.phase === 'begin').map((r) => [r.executionId, r]),
    );
    const completedActsDuringWait = dbEventsWhileWaiting.filter(
      (row) => row.phase === 'complete' && beginByExecIdWhileWaiting.get(row.executionId)?.toolCallId === heldActToolCallId,
    );
    expect(completedActsDuringWait).toHaveLength(0);

    // User finishes login and taps Done (HTTP resume control)
    const resumeRes = await postSurfaceBridge<{
      snapshot: { sessions: Array<{ session: { state: string } }> };
    }>('control', {
      version: 1,
      conversationId,
      surfaceSessionId,
      action: 'resume',
    });
    expect(resumeRes.success).toBe(true);
    expect(resumeRes.data?.snapshot.sessions[0]?.session.state).toBe('running');

    const releasedAct = await pendingAct;
    clearApprovalWait(heldActToolCallId);

    // ② Held act with OLD stateId is rejected with SURFACE_STATE_STALE + human-touched note; still 0 MCP input calls
    expect(releasedAct.success).toBe(false);
    expect(releasedAct.metadata?.code).toBe('SURFACE_STATE_STALE');
    expect(String(releasedAct.error).startsWith(`${EXPECTED_SCREEN_TOUCHED_NOTE}\n\n`)).toBe(true);
    expect(readDriverLog(driverJsonlPath).filter((c) => INPUT_TOOL_NAMES.has(c.toolName))).toHaveLength(0);

    // Retrying with OLD stateId after hand-back is ALSO rejected with SURFACE_STATE_STALE and 0 input calls
    const retryOldState = await executor.execute(
      'computer_use',
      {
        operation: 'act',
        targetApp: 'Notes',
        stateId: preTakeoverStateId,
        mutation: { kind: 'type_text', elementRef: 'e1', value: 'Should not type on stale state' },
      },
      {
        sessionId: conversationId,
        runId,
        agentId: 'main',
        currentToolCallId: `${runId}:act-stale-retry`,
      },
    );
    expect(retryOldState.success).toBe(false);
    expect(retryOldState.metadata?.code).toBe('SURFACE_STATE_STALE');
    expect(readDriverLog(driverJsonlPath).filter((c) => INPUT_TOOL_NAMES.has(c.toolName))).toHaveLength(0);

    // Fresh observe after hand-back succeeds and returns the post-login unlocked screen
    const freshObserve = await executor.execute(
      'computer_use',
      { operation: 'observe', targetApp: 'Notes', target: { pid: 42, windowId: 7 } },
      {
        sessionId: conversationId,
        runId,
        agentId: 'main',
        currentToolCallId: `${runId}:observe-after-resume`,
      },
    );
    expect(freshObserve.success).toBe(true);
    const freshState = (JSON.parse(String(freshObserve.output)) as {
      state: { stateId: string; elements: Array<{ ref: string; label?: string }> };
    }).state;
    expect(freshState.stateId).not.toBe(preTakeoverStateId);
    expect(freshState.elements.some((el) => el.label === 'Weekly report body')).toBe(true);

    // Subsequent act on fresh stateId dispatches to fake cua-driver and records success in SQLite
    const freshAct = await executor.execute(
      'computer_use',
      {
        operation: 'act',
        targetApp: 'Notes',
        stateId: freshState.stateId,
        mutation: { kind: 'type_text', elementRef: 'e1', value: '- Shipped CUA takeover proof' },
      },
      {
        sessionId: conversationId,
        runId,
        agentId: 'main',
        currentToolCallId: `${runId}:act-fresh`,
      },
    );
    expect(freshAct.success).toBe(true);
    expect(readDriverLog(driverJsonlPath).filter((c) => c.toolName === 'type_text')).toHaveLength(1);

    const finalDbRows = toolEventRepo.getBySession(conversationId);
    const beginByExecId = new Map(
      finalDbRows.filter((r) => r.phase === 'begin').map((r) => [r.executionId, r]),
    );
    const completedRows = finalDbRows.filter((r) => r.phase === 'complete');
    expect(completedRows.map((r) => ({
      toolCallId: beginByExecId.get(r.executionId)?.toolCallId,
      operation: beginByExecId.get(r.executionId)?.params?.operation,
      status: r.status,
    }))).toEqual([
      { toolCallId: `${runId}:list-roots`, operation: 'list_roots', status: 'success' },
      { toolCallId: `${runId}:observe-1`, operation: 'observe', status: 'success' },
      { toolCallId: heldActToolCallId, operation: 'act', status: 'error' },
      { toolCallId: `${runId}:act-stale-retry`, operation: 'act', status: 'error' },
      { toolCallId: `${runId}:observe-after-resume`, operation: 'observe', status: 'success' },
      { toolCallId: `${runId}:act-fresh`, operation: 'act', status: 'success' },
    ]);
  });

  it('③ books a >120s takeover wait as human wait via ToolExecutor + watchdog so the 120s no-progress limit never fires', async () => {
    const conversationId = 'conv-it-budget';
    const runId = 'run-it-budget';
    const executor = startConversationAndRun(conversationId, runId);
    const { stateId, surfaceSessionId } = await seedObservedViaExecutor(executor, conversationId, runId);

    const takeoverRes = await postSurfaceBridge('control', {
      version: 1,
      conversationId,
      surfaceSessionId,
      action: 'takeover',
    });
    expect(takeoverRes.success).toBe(true);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const toolCallId = `${runId}:act-130s`;
    const watchdogEvents: AgentEvent[] = [];
    const onTimeoutWarn = vi.fn();
    const aborted = vi.fn();
    const watchdog = createToolExecutionWatchdog({
      toolCallId,
      toolName: 'computer_use',
      startedAt: Date.now(),
      onEvent: (ev) => watchdogEvents.push(ev),
      onTimeoutWarn,
    });
    const runBudget = createHumanWaitBoundTimeout(180_000, 'run budget exceeded', conversationId);
    watchdog.startProgressReporter();

    try {
      expect(getToolExecutionTimeoutMs('computer_use')).toBe(120_000);
      const watched = watchdog.awaitExecution(
        executor.execute(
          'computer_use',
          {
            operation: 'act',
            targetApp: 'Notes',
            stateId,
            mutation: { kind: 'click', elementRef: 'e2' },
          },
          {
            sessionId: conversationId,
            runId,
            agentId: 'main',
            currentToolCallId: toolCallId,
          },
        ),
        aborted,
      );

      // Flush async microtasks so ToolExecutor enters awaitComputerHumanTakeoverRelease before advancing timers
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(135_000);

      expect(getApprovalWaitMs(toolCallId, Date.now())).toBeGreaterThanOrEqual(134_500);
      expect(runBudget.controller.getElapsedMs(Date.now())).toBeLessThan(1_000);
      expect(watchdogEvents.filter((ev) => ev.type === 'tool_timeout')).toEqual([]);
      expect(onTimeoutWarn).not.toHaveBeenCalled();
      expect(aborted).not.toHaveBeenCalled();

      const resumePromise = postSurfaceBridge('control', {
        version: 1,
        conversationId,
        surfaceSessionId,
        action: 'resume',
      });
      await vi.advanceTimersByTimeAsync(250);
      const resumeRes = await resumePromise;
      expect(resumeRes.success).toBe(true);
      await vi.advanceTimersByTimeAsync(250);

      const result = await watched;
      expect(result.success).toBe(false);
      expect(result.metadata?.code).toBe('SURFACE_STATE_STALE');
      expect(isHumanWaitActive(conversationId)).toBe(false);
    } finally {
      clearApprovalWait(toolCallId);
      watchdog.stop();
      runBudget.unbind();
      runBudget.controller.clear();
      vi.useRealTimers();
    }
  });

  it('④ ends takeover wait in <1s without hanging on HTTP stop, HTTP end_session, and run abortSignal', async () => {
    // 1. HTTP stop control
    {
      const conv = 'conv-it-stop';
      const run = 'run-it-stop';
      const executor = startConversationAndRun(conv, run);
      const { stateId, surfaceSessionId } = await seedObservedViaExecutor(executor, conv, run);
      await postSurfaceBridge('control', { version: 1, conversationId: conv, surfaceSessionId, action: 'takeover' });

      const pending = executor.execute(
        'computer_use',
        { operation: 'act', targetApp: 'Notes', stateId, mutation: { kind: 'click', elementRef: 'e2' } },
        { sessionId: conv, runId: run, agentId: 'main', currentToolCallId: `${run}:act-stop` },
      );
      await new Promise((r) => setTimeout(r, 150));

      const t0 = Date.now();
      const stopRes = await postSurfaceBridge<{
        snapshot: { sessions: Array<{ session: { state: string } }> };
      }>('control', { version: 1, conversationId: conv, surfaceSessionId, action: 'stop' });
      const settled = await pending;
      const elapsedMs = Date.now() - t0;
      clearApprovalWait(`${run}:act-stop`);

      expect(stopRes.success).toBe(true);
      expect(elapsedMs).toBeLessThan(1_000);
      expect(settled.success).toBe(false);
      expect(settled.metadata?.code).toBe('SURFACE_SESSION_BUSY');
      expect(stopRes.data?.snapshot.sessions[0]?.session.state).toBe('stopping');
      expect(isHumanWaitActive(conv)).toBe(false);
    }

    // 2. HTTP end_session control
    {
      const conv = 'conv-it-end';
      const run = 'run-it-end';
      const executor = startConversationAndRun(conv, run);
      const { stateId, surfaceSessionId } = await seedObservedViaExecutor(executor, conv, run);
      await postSurfaceBridge('control', { version: 1, conversationId: conv, surfaceSessionId, action: 'takeover' });

      const pending = executor.execute(
        'computer_use',
        { operation: 'act', targetApp: 'Notes', stateId, mutation: { kind: 'click', elementRef: 'e2' } },
        { sessionId: conv, runId: run, agentId: 'main', currentToolCallId: `${run}:act-end` },
      );
      await new Promise((r) => setTimeout(r, 150));

      const t0 = Date.now();
      const endRes = await postSurfaceBridge<{
        snapshot: { sessions: Array<{ session: { state: string } }> };
      }>('control', { version: 1, conversationId: conv, surfaceSessionId, action: 'end_session' });
      const settled = await pending;
      const elapsedMs = Date.now() - t0;
      clearApprovalWait(`${run}:act-end`);

      expect(endRes.success).toBe(true);
      expect(elapsedMs).toBeLessThan(1_000);
      expect(settled.success).toBe(false);
      expect(settled.metadata?.code).toBe('SURFACE_SESSION_BUSY');
      expect(endRes.data?.snapshot.sessions[0]?.session.state).toBe('completed');
      expect(isHumanWaitActive(conv)).toBe(false);

      await projectionService?.flushPersistence(conv);
      const stored = dbService.getSession(conv);
      const ledger = stored?.metadata?.surfaceExecutionLedgerV1 as
        | { sessions?: Array<{ session: { state: string } }> }
        | undefined;
      expect(ledger?.sessions?.[0]?.session.state).toBe('completed');
    }

    // 3. Run abortSignal cancellation
    {
      const conv = 'conv-it-abort';
      const run = 'run-it-abort';
      const executor = startConversationAndRun(conv, run);
      const { stateId, surfaceSessionId } = await seedObservedViaExecutor(executor, conv, run);
      await postSurfaceBridge('control', { version: 1, conversationId: conv, surfaceSessionId, action: 'takeover' });

      const abortController = new AbortController();
      const pending = executor.execute(
        'computer_use',
        { operation: 'act', targetApp: 'Notes', stateId, mutation: { kind: 'click', elementRef: 'e2' } },
        {
          sessionId: conv,
          runId: run,
          agentId: 'main',
          currentToolCallId: `${run}:act-abort`,
          abortSignal: abortController.signal,
        },
      );
      await new Promise((r) => setTimeout(r, 150));

      const t0 = Date.now();
      abortController.abort('user cancelled run');
      const settled = await pending;
      const elapsedMs = Date.now() - t0;
      clearApprovalWait(`${run}:act-abort`);

      expect(elapsedMs).toBeLessThan(1_000);
      expect(settled.success).toBe(false);
      expect(settled.metadata?.code).toBe('SURFACE_REQUEST_CANCELLED');
      expect(isHumanWaitActive(conv)).toBe(false);
    }

    expect(readDriverLog(driverJsonlPath).filter((c) => INPUT_TOOL_NAMES.has(c.toolName))).toHaveLength(0);
  });

  it('④b run cancel during takeover: held act settles <1s and the run-end cleanup (RunFinalizer path) ends the Surface session instead of leaving it waiting_human', async () => {
    const conv = 'conv-it-cancel-cleanup';
    const run = 'run-it-cancel-cleanup';
    const executor = startConversationAndRun(conv, run);
    const { stateId, surfaceSessionId } = await seedObservedViaExecutor(executor, conv, run);
    await postSurfaceBridge('control', { version: 1, conversationId: conv, surfaceSessionId, action: 'takeover' });

    const pending = executor.execute(
      'computer_use',
      { operation: 'act', targetApp: 'Notes', stateId, mutation: { kind: 'click', elementRef: 'e2' } },
      { sessionId: conv, runId: run, agentId: 'main', currentToolCallId: `${run}:act-cancel` },
    );
    await new Promise((r) => setTimeout(r, 150));

    // Normal stop API: RunHandle.cancel (what POST /api/cancel calls) — run stays registered while its loop unwinds.
    const t0 = Date.now();
    await runRegistry.get(run)?.cancel('user');
    const settled = await pending;
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(settled.success).toBe(false);
    clearApprovalWait(`${run}:act-cancel`);

    // RunFinalizer calls surfaceRuntime.endRun for the cancelled run.
    await surfaceRuntime.endRun({ conversationId: conv, runId: run, agentId: 'main' });
    const snap = await postSurfaceBridge<{
      sessions: Array<{ session: { sessionId: string; state: string } }>;
    }>('getSnapshot', { version: 1, conversationId: conv });
    const states = (snap.data?.sessions ?? [])
      .filter((s) => s.session.sessionId === surfaceSessionId)
      .map((s) => s.session.state);
    expect(states).toEqual(['completed']);
    expect(isHumanWaitActive(conv)).toBe(false);
  });
});
