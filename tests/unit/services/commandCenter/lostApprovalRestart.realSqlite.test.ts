import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../../src/host/services/core/database/migrations';
import { applyConversationBranchSchema } from '../../../../src/host/services/core/database/schemaConversationBranch';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { PendingApprovalRepository } from '../../../../src/host/services/core/repositories/PendingApprovalRepository';
import { SessionRepository } from '../../../../src/host/services/core/repositories/SessionRepository';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { createUnavailableNativeRecoveryPorts } from '../../../../src/host/runtime/nativeRecoveryHost';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { createDurableRecoveryRuntime } from '../../../../src/host/runtime/durableRecoveryRuntime';
import { mapDurableRunView, projectDurableRunToSessionPayload } from '../../../../src/host/app/durableRunReadService';
import { markSessionCommandTaskRunning, recoverInterruptedSessionCommandTasks, settleSessionCommandTaskMarkerForDeferredProjection } from '../../../../src/host/services/commandCenter/sessionCommandTaskRestartRecovery';
import { resetBackgroundTaskLedgerForTest } from '../../../../src/host/task/backgroundTaskLedger';
import type { Message } from '../../../../src/shared/contract';

const ports = vi.hoisted(() => ({ database: null as unknown, sessions: null as unknown }));
vi.mock('../../../../src/host/services/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), getDatabase: () => ports.database,
}));
vi.mock('../../../../src/host/services/core/configService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'en' } }) }),
}));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: async (id: string, message: Message) => (ports.sessions as SessionRepository).addMessage(id, message),
  }),
}));

const SESSION = 'lost-delete-session';
const RUN = 'lost-delete-root';
const dispatchTool = vi.fn(async (): Promise<never> => { throw new Error('Unexpected tool execution'); });
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('lost background approval restart closure (real file-backed SQLite)', () => {
  let dir: string;
  let previousDataDir: string | undefined;
  let db: Database.Database;
  let runs: DurableRunRepository;
  let approvals: PendingApprovalRepository;
  let sessions: SessionRepository;
  let registry: RunRegistry;
  let kernel: DurableRunKernel;
  let now: number;

  beforeEach(async () => {
    now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'lost-approval-restart-')));
    process.env.CODE_AGENT_DATA_DIR = dir;
    db = new Database(path.join(dir, 'test.db'));
    applySchema(db, logger as never);
    applySessionsMigrations(db, logger as never);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    sessions = new SessionRepository(db);
    approvals = new PendingApprovalRepository(db);
    runs = new DurableRunRepository(db);
    runs.migrate();
    ports.database = { getDb: () => db, getDurableRunRepository: () => runs, getPendingApprovalRepo: () => approvals };
    ports.sessions = sessions;
    sessions.createSession({
      id: SESSION, title: 'Clean old logs', modelConfig: { provider: 'test', model: 'test' },
      status: 'running', createdAt: now, updatedAt: now,
    });
    registry = new RunRegistry();
    kernel = new DurableRunKernel({ stores: runs, ownerId: 'host', processInstanceId: 'killed-process', leaseDurationMs: 100 });
    registry.configureDurableKernel(kernel);
    await registry.startDurable({ runId: RUN, sessionId: SESSION, workspace: dir, cwd: dir }, now);
    await checkpointTool(RUN, now);
    now = 1_010;
    markSessionCommandTaskRunning({ id: 'delete-task', sessionId: SESSION, title: 'Clean old logs', shortName: 'Cleanup', createdAt: now });
  });

  afterEach(() => {
    expect(dispatchTool).not.toHaveBeenCalled();
    dispatchTool.mockClear();
    registry.clear();
    resetBackgroundTaskLedgerForTest();
    db.close();
    vi.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  function restart() {
    registry.clear();
    registry = new RunRegistry();
    kernel = new DurableRunKernel({ stores: runs, ownerId: 'host', processInstanceId: 'restarted-process', leaseDurationMs: 100 });
    registry.configureDurableKernel(kernel);
  }

  async function checkpointTool(runId: string, at: number, status: 'dispatched' | 'succeeded' = 'dispatched') {
    await registry.checkpointNativeToolOperation({
      runId, sourceMessageId: 'cleanup-request', toolName: 'Bash', logicalOperationId: `${runId}-delete`,
      providerOperationId: `${runId}-execution`, sideEffect: true, status, now: at,
    });
  }

  function seedSurvivingApproval() {
    approvals.insert({
      id: 'surviving-delete', kind: 'tool_approval', agentId: null, agentName: null, coordinatorId: SESSION,
      payload: { sessionId: SESSION, toolCallId: 'delete-call', tool: 'Bash', requestedAt: 1_005 },
      submittedAt: 1_005,
    });
  }

  function runtime() {
    const ports = createUnavailableNativeRecoveryPorts();
    return createDurableRecoveryRuntime({
      registry, kernel, dataDir: dir,
      nativeRecoveryPorts: { ...ports, tool: { ...ports.tool, dispatchPrepared: dispatchTool } },
    });
  }

  it('crash-interrupted native root is untouched by task restart recovery and remains recoverable', async () => {
    const closeRoot = vi.spyOn(runs, 'closeParkedWaitingRunForSession');
    const before = await runs.get(RUN);
    expect(await runs.listPendingOperations(RUN)).toMatchObject([
      { kind: 'tool_call', status: 'dispatched', sideEffect: true,
        providerOperationId: `${RUN}-execution`, requiresHumanConfirmation: undefined },
    ]);
    restart();
    now = 1_200;
    expect(await recoverInterruptedSessionCommandTasks()).toBe(1);
    expect(closeRoot).not.toHaveBeenCalled();
    expect(await runs.get(RUN)).toEqual(before);
    const plans = await registry.recoverDurable(now);
    expect(plans).toHaveLength(1);
    expect(plans[0].envelope).toMatchObject({ runId: RUN, status: 'recovering', engine: { kind: 'native' } });
    expect(plans[0].pendingOperations).toMatchObject([
      { kind: 'tool_call', status: 'prepared', providerOperationId: `${RUN}-execution` },
    ]);
    expect((await runs.get(RUN))?.terminal).toBeUndefined();
  });

  it('settled terminal marker only reprojects its result and leaves the root alone', async () => {
    const before = await runs.get(RUN);
    settleSessionCommandTaskMarkerForDeferredProjection({
      id: 'delete-task', sessionId: SESSION, title: 'Clean old logs', shortName: 'Cleanup',
      createdAt: 1_010, status: 'completed', resultText: 'Files reviewed',
    });
    restart();
    now = 1_200;
    await recoverInterruptedSessionCommandTasks();
    expect(await runs.get(RUN)).toEqual(before);
    expect(sessions.getMessages(SESSION).some((message) => message.metadata?.backgroundTaskInterrupted)).toBe(false);
  });

  async function seedChild(status: 'running' | 'waiting' | 'recovering' = 'running', sessionId = SESSION, options: { sibling?: boolean; completed?: boolean } = {}) {
    await registry.startAuxiliaryDurableChild({
      runId: 'delete-task', sessionId, workspace: dir, cwd: dir,
    }, RUN, 1_020);
    await checkpointTool('delete-task', 1_020);
    if (status !== 'running') {
      // Snapshot the interrupted child's status through the same checkpoint writer,
      // preserving the production tool operation and native descriptor unchanged.
      const child = registry.getDurableEnvelope('delete-task')!;
      await registry.checkpointDurable('delete-task', {
        now: 1_021, status, state: registry.getDurableCheckpointState('delete-task'),
        pendingOperations: child.pendingOperations ?? [], childRuns: child.childRuns,
        events: [{ type: 'run_checkpointed', payload: {}, recordedAt: 1_021 }],
      });
    }
    if (options.sibling) {
      await registry.startAuxiliaryDurableChild({
        runId: 'sibling-task', sessionId: SESSION, workspace: dir, cwd: dir,
      }, RUN, 1_021);
      await checkpointTool('sibling-task', 1_021);
    }
    if (options.completed) {
      await checkpointTool('delete-task', 1_023, 'succeeded');
      await registry.terminalDurable('delete-task', {
        status: 'completed', now: 1_023,
        event: { type: 'run_completed', payload: {}, recordedAt: 1_023 },
      });
    }
    await checkpointTool(RUN, 1_024, 'succeeded');
    await registry.terminalDurable(RUN, {
      now: 1_025, status: 'completed',
      event: { type: 'run_completed', payload: {}, recordedAt: 1_025 },
    });
    restart();
    now = 1_200;
  }

  async function latestProjection() {
    return projectDurableRunToSessionPayload(mapDurableRunView('session_replay', (await runs.getLatestBySession(SESSION))!));
  }

  it.each(['running', 'waiting', 'recovering'] as const)('child (a) production recovery closes expired %s task child; clears marker; second pass preserves updated_at', async (status) => {
    await seedChild(status);
    const root = await runs.get(RUN);
    expect(root?.status).toBe('completed');
    expect(await runs.listPendingOperations('delete-task')).toMatchObject([
      { kind: 'tool_call', status: 'dispatched', sideEffect: true,
        providerOperationId: 'delete-task-execution', requiresHumanConfirmation: undefined },
    ]);
    expect(approvals.listByKindAndStatus('tool_approval', 'pending')).toEqual([]);
    if (status === 'waiting') {
      expect(await latestProjection()).toMatchObject({ durableWaitingInput: true });
      console.log('PRE-FIX child engine_kind=native status=waiting pending_approvals=[] payload=', await latestProjection());
    }
    const closeRoot = vi.spyOn(runs, 'closeParkedWaitingRunForSession');
    await recoverInterruptedSessionCommandTasks();
    expect(closeRoot).not.toHaveBeenCalled();
    expect(await runs.get('delete-task')).toMatchObject({
      status: 'cancelled', attempt: 2, owner: { epoch: 2 },
      terminal: { reason: 'approval_lost_on_restart' },
    });
    expect(await latestProjection()).toEqual({ status: 'interrupted' });
    expect(dispatchTool).not.toHaveBeenCalled();
    const child = await runs.get('delete-task');
    const recovery = runtime();
    expect(await recovery.recoverAndDispatch(now)).toEqual([]);
    now = 1_500;
    expect(await recoverInterruptedSessionCommandTasks()).toBe(0);
    expect(await recovery.recoverAndDispatch(now)).toEqual([]);
    expect(await runs.get('delete-task')).toEqual(child);
    expect(await runs.get(RUN)).toEqual(root);
    await recovery.shutdown();
  });

  it('child (b) live lease remains untouched until production deferred retry at expiry', async () => {
    await seedChild();
    now = 1_050;
    const before = await runs.get('delete-task');
    await recoverInterruptedSessionCommandTasks();
    expect(await runs.get('delete-task')).toEqual(before);
    const recovery = runtime();
    expect(await recovery.recoverAndDispatch(1_100)).toEqual([]);
    expect(await runs.get('delete-task')).toEqual(before);
    expect(await recovery.recoverAndDispatch(1_120)).toEqual([]);
    expect(await runs.get('delete-task')).toMatchObject({ status: 'cancelled', terminal: { reason: 'approval_lost_on_restart' } });
    expect(await latestProjection()).toEqual({ status: 'interrupted' });
    await recovery.shutdown();
  });

  it('child (c) surviving pending tool approval preserves waiting child and marker', async () => {
    await seedChild('waiting');
    seedSurvivingApproval();
    const before = await runs.get('delete-task');
    await recoverInterruptedSessionCommandTasks();
    expect(await runs.get('delete-task')).toEqual(before);
    expect(await latestProjection()).toMatchObject({ durableWaitingInput: true });
  });

  it('child deferred retry rechecks a pending tool approval inserted after startup', async () => {
    await seedChild('waiting');
    now = 1_050;
    await recoverInterruptedSessionCommandTasks();
    seedSurvivingApproval();
    const before = await runs.get('delete-task');
    const recovery = runtime();
    await recovery.recoverAndDispatch(1_100);
    expect(await runs.get('delete-task')).toEqual(before);
    expect(await latestProjection()).toMatchObject({ durableWaitingInput: true });
    await recovery.shutdown();
  });

  it('child (d) same-session sibling with another run_id stays untouched', async () => {
    await seedChild('running', SESSION, { sibling: true });
    const sibling = await runs.get('sibling-task');
    await recoverInterruptedSessionCommandTasks();
    expect(await runs.get('delete-task')).toMatchObject({ status: 'cancelled' });
    expect(await runs.get('sibling-task')).toEqual(sibling);
  });

  it('child belonging to another session is untouched even if taskId matches', async () => {
    await seedChild('waiting', 'another-session');
    const before = await runs.get('delete-task');
    await recoverInterruptedSessionCommandTasks();
    expect(await runs.get('delete-task')).toEqual(before);
  });

  it('already-terminal child is a no-op without an updated_at rewrite', async () => {
    await seedChild('running', SESSION, { completed: true });
    const before = await runs.get('delete-task');
    now = 1_500;
    await recoverInterruptedSessionCommandTasks();
    expect(await runs.get('delete-task')).toEqual(before);
  });

  it('existing abandoned claims still support their explicit live-lease takeover without the new opt-in', async () => {
    await seedChild();
    const child = (await runs.get('delete-task'))!;
    expect(await runs.claimAbandonedLease({
      runId: child.runId, expectedEpoch: child.owner!.epoch,
      abandonedProcessInstanceId: child.owner!.processInstanceId,
      ownerId: 'host', processInstanceId: 'explicit-abandoned-recovery', now: 1_050, leaseDurationMs: 100,
    })).toMatchObject({ envelope: { status: 'recovering' }, owner: { epoch: 2 } });
  });

  it('lease renewed between child read and abandoned claim is fenced atomically', async () => {
    await seedChild();
    const child = (await runs.get('delete-task'))!;
    const claim = runs.claimAbandonedLease.bind(runs);
    vi.spyOn(runs, 'claimAbandonedLease').mockImplementationOnce(async (input) => {
      await runs.renewLease(child.runId, child.owner!, 1_500);
      return claim(input);
    });
    await recoverInterruptedSessionCommandTasks();
    expect(await runs.get('delete-task')).toMatchObject({
      status: 'running', attempt: 1, owner: { epoch: 1, leaseExpiresAt: 1_500 },
    });
    expect((await runs.get('delete-task'))?.terminal).toBeUndefined();
    const recovery = runtime();
    expect(await recovery.recoverAndDispatch(1_500)).toEqual([]);
    expect(await runs.get('delete-task')).toMatchObject({ status: 'cancelled' });
    await recovery.shutdown();
  });

});
