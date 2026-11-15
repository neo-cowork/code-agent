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
    const operation = kernel.prepareToolOperation({
      runId: RUN, logicalCallId: 'delete-logs', attempt: 1,
      sideEffect: true, canDeduplicate: false, now,
    });
    await registry.checkpointDurable(RUN, {
      now, status: 'running', pendingOperations: [{ ...operation, status: 'dispatched' }],
      state: {}, childRuns: [], events: [{ type: 'run_checkpointed', payload: {}, recordedAt: now }],
    });
    now = 1_010;
    markSessionCommandTaskRunning({ id: 'delete-task', sessionId: SESSION, title: 'Clean old logs', shortName: 'Cleanup', createdAt: now });
    registry.clear();
    registry = new RunRegistry();
    kernel = new DurableRunKernel({ stores: runs, ownerId: 'host', processInstanceId: 'restarted-process', leaseDurationMs: 100 });
    registry.configureDurableKernel(kernel);
  });

  afterEach(() => {
    registry.clear();
    resetBackgroundTaskLedgerForTest();
    db.close();
    vi.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  async function projection() {
    return projectDurableRunToSessionPayload(mapDurableRunView('session_replay', (await runs.get(RUN))!));
  }

  function seedSurvivingApproval() {
    approvals.insert({
      id: 'surviving-delete', kind: 'tool_approval', agentId: null, agentName: null, coordinatorId: SESSION,
      payload: { sessionId: SESSION, toolCallId: 'delete-call', tool: 'Bash', requestedAt: 1_005 },
      submittedAt: 1_005,
    });
  }

  function runtime() {
    return createDurableRecoveryRuntime({ registry, kernel, dataDir: dir });
  }

  it('① pre-fix kernel recovery projects waiting input without any pending approval row', async () => {
    expect(await runs.listPendingOperations(RUN)).toMatchObject([
      { kind: 'tool_call', sideEffect: true, status: 'dispatched' },
    ]);
    now = 1_200;
    const plans = await kernel.recoverOnStartup(now);
    expect(approvals.listByKindAndStatus('tool_approval', 'pending')).toEqual([]);
    expect(plans[0].envelope).toMatchObject({ engine: { kind: 'native' }, status: 'waiting' });
    expect(plans[0].pendingOperations).toMatchObject([
      { kind: 'tool_call', sideEffect: true, status: 'unknown', requiresHumanConfirmation: true },
    ]);
    expect(await projection()).toMatchObject({ durableWaitingInput: true });
    console.log('PRE-FIX recoverOnStartup engine_kind=native status=waiting pending_approvals=[] payload=', await projection());
  });

  it.each(['running', 'waiting'] as const)('② production startup closes %s orphan; projection clears; second recovery does not rewrite updated_at', async (status) => {
    if (status === 'waiting') {
      now = 1_200;
      await kernel.recoverOnStartup(now);
    }
    now = 1_300;
    expect(await recoverInterruptedSessionCommandTasks()).toBe(1);
    const recovery = runtime();
    const closed = await runs.get(RUN);
    expect(closed).toMatchObject({ status: 'cancelled', terminal: { reason: 'approval_lost_on_restart' } });
    expect(await projection()).toEqual({ status: 'interrupted' });
    expect(await recovery.recoverAndDispatch(now)).toEqual([]);
    expect(sessions.getMessages(SESSION).some((message) => message.metadata?.backgroundTaskInterrupted)).toBe(true);
    const row = db.prepare('SELECT updated_at FROM durable_runs WHERE run_id = ?').get(RUN);
    now = 1_500;
    expect(await recoverInterruptedSessionCommandTasks()).toBe(0);
    expect(await recovery.recoverAndDispatch(now)).toEqual([]);
    expect(db.prepare('SELECT updated_at FROM durable_runs WHERE run_id = ?').get(RUN)).toEqual(row);
    await recovery.shutdown();
  });

  it('③ surviving pending tool_approval keeps waiting run and sidebar marker untouched', async () => {
    seedSurvivingApproval();
    now = 1_200;
    await kernel.recoverOnStartup(now);
    const before = await runs.get(RUN);
    expect(await projection()).toMatchObject({ durableWaitingInput: true });
    expect(await recoverInterruptedSessionCommandTasks()).toBe(1);
    expect(await runs.get(RUN)).toEqual(before);
    expect(approvals.getById('surviving-delete')?.status).toBe('pending');
    expect(await projection()).toMatchObject({ durableWaitingInput: true });
  });

  it('live lease stays fenced until production durable recovery retries after expiry', async () => {
    const before = await runs.get(RUN);
    expect(await recoverInterruptedSessionCommandTasks()).toBe(1);
    expect(await runs.get(RUN)).toEqual(before);
    const recovery = runtime();
    expect(await recovery.recoverAndDispatch(1_050)).toEqual([]);
    expect(await runs.get(RUN)).toEqual(before);
    expect(await recovery.recoverAndDispatch(1_100)).toEqual([]);
    expect(await runs.get(RUN)).toMatchObject({ status: 'cancelled', terminal: { reason: 'approval_lost_on_restart' } });
    expect(await projection()).toEqual({ status: 'interrupted' });
    await recovery.shutdown();
  });

  it('deferred close rechecks surviving approvals before touching the expired run', async () => {
    await recoverInterruptedSessionCommandTasks();
    seedSurvivingApproval();
    const before = await runs.get(RUN);
    // Before expiry this production entry retries the queued close, then finds no recoverable lease.
    const recovery = runtime();
    await recovery.recoverAndDispatch(1_050);
    expect(await runs.get(RUN)).toEqual(before);
    now = 1_200;
    await kernel.recoverOnStartup(now);
    const parked = await runs.get(RUN);
    await recoverInterruptedSessionCommandTasks();
    expect(await runs.get(RUN)).toEqual(parked);
    expect(await projection()).toMatchObject({ durableWaitingInput: true });
    await recovery.shutdown();
  });

  it.each([
    ['user_stop waiting run', 'waiting', 'user_stop', true],
    ['quota_wait waiting run', 'waiting', 'quota_wait', true],
    ['crashed foreground run with no approval parked', 'running', undefined, false],
  ] as const)('④ %s of the same session is not an approval-lost run: untouched by task restart closure', async (_name, status, cause, keepOperation) => {
    const current = (await runs.get(RUN))!;
    const ops = (await runs.listPendingOperations(RUN)).map((op) => ({
      ...op, status: 'unknown' as const, requiresHumanConfirmation: true,
    }));
    await runs.replaceRecoveryProjection({
      runId: RUN, attempt: current.attempt, expectedOwnerEpoch: current.owner!.epoch,
      status: status === 'running' ? 'recovering' : status, pendingOperations: keepOperation ? ops : [], updatedAt: 1_020,
      ...(cause ? { interruptCause: cause } : {}),
    });
    if (status === 'running') {
      await runs.transition({
        runId: RUN, expectedStatus: 'recovering', nextStatus: 'running',
        expectedOwnerEpoch: current.owner!.epoch, updatedAt: 1_020,
      });
    }
    now = 1_300;
    const before = await runs.get(RUN);
    expect(await recoverInterruptedSessionCommandTasks()).toBe(1);
    expect(await runs.get(RUN)).toEqual(before);
    const recovery = runtime();
    await recovery.recoverAndDispatch(1_400);
    expect((await runs.get(RUN))?.terminal?.reason).not.toBe('approval_lost_on_restart');
    await recovery.shutdown();
  });

  it.each([
    { status: 'dispatched', sideEffect: false, requiresHumanConfirmation: false },
    { status: 'dispatched', providerOperationId: 'deduplicated-call', requiresHumanConfirmation: false },
    { status: 'unknown', requiresHumanConfirmation: false },
    { status: 'prepared' },
  ] as const)('④ recoverable operation %j does not authorize approval-lost closure', async (operation) => {
    const current = (await runs.get(RUN))!;
    const ops = (await runs.listPendingOperations(RUN)).map((op) => ({ ...op, ...operation }));
    await runs.replaceRecoveryProjection({
      runId: RUN, attempt: current.attempt, expectedOwnerEpoch: current.owner!.epoch,
      status: 'recovering', pendingOperations: ops, updatedAt: 1_020,
    });
    now = 1_300;
    const before = await runs.get(RUN);
    expect(await recoverInterruptedSessionCommandTasks()).toBe(1);
    expect(await runs.get(RUN)).toEqual(before);
  });

  it('settled terminal marker only reprojects its result and leaves the run alone', async () => {
    now = 1_200;
    await kernel.recoverOnStartup(now);
    const before = await runs.get(RUN);
    settleSessionCommandTaskMarkerForDeferredProjection({
      id: 'delete-task', sessionId: SESSION, title: 'Clean old logs', shortName: 'Cleanup',
      createdAt: 1_010, status: 'completed', resultText: 'Files reviewed',
    });
    await recoverInterruptedSessionCommandTasks();
    expect(await runs.get(RUN)).toEqual(before);
    expect(sessions.getMessages(SESSION).some((message) => message.metadata?.backgroundTaskInterrupted)).toBe(false);
  });

  it('old interrupted task cannot close a newer root run in the same session', async () => {
    now = 1_200;
    await runs.closeParkedWaitingRunForSession({ sessionId: SESSION, now, reason: 'fixture_old_run_ended', approvalRequestedAt: now });
    await registry.startDurable({ runId: 'newer-root', sessionId: SESSION, workspace: dir, cwd: dir }, now);
    const newer = await runs.get('newer-root');
    now = 1_300;
    await recoverInterruptedSessionCommandTasks();
    expect(await runs.get('newer-root')).toEqual(newer);
  });

  async function seedChild(status: 'running' | 'waiting' | 'recovering' = 'running', sessionId = SESSION) {
    // Complete the parent's pending tool projection before completing the foreground turn.
    const current = (await runs.get(RUN))!;
    await runs.replaceRecoveryProjection({
      runId: RUN, attempt: current.attempt, expectedOwnerEpoch: current.owner!.epoch,
      status: 'recovering', pendingOperations: [], updatedAt: 1_014,
    });
    await runs.transition({
      runId: RUN, expectedStatus: 'recovering', nextStatus: 'running',
      expectedOwnerEpoch: current.owner!.epoch, updatedAt: 1_014,
    });
    const root = (await runs.get(RUN))!;
    await runs.commitTerminal({
      runId: RUN, attempt: root.attempt, expectedOwnerEpoch: root.owner!.epoch,
      expectedNextEventSeq: root.cursor.nextEventSeq, status: 'completed', terminalAt: 1_015,
      event: { type: 'run_completed', payload: {}, recordedAt: 1_015 },
    });
    await kernel.createRun({
      runId: 'delete-task', sessionId, parentRunId: RUN, engine: { kind: 'native' },
      now: 1_020, initialStatus: status,
    });
    now = 1_200;
  }

  async function latestProjection() {
    return projectDurableRunToSessionPayload(mapDurableRunView('session_replay', (await runs.getLatestBySession(SESSION))!));
  }

  it.each(['running', 'waiting', 'recovering'] as const)('child (a) production recovery closes expired %s task child; clears marker; second pass preserves updated_at', async (status) => {
    await seedChild(status);
    const root = await runs.get(RUN);
    await recoverInterruptedSessionCommandTasks();
    expect(await runs.get('delete-task')).toMatchObject({
      status: 'cancelled', attempt: 2, owner: { epoch: 2 },
      terminal: { reason: 'approval_lost_on_restart' },
    });
    expect(await latestProjection()).toEqual({ status: 'interrupted' });
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
    await seedChild();
    await kernel.createNativeRun({ runId: 'sibling-task', sessionId: SESSION, parentRunId: RUN, now: 1_019 });
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
    await seedChild();
    const child = (await runs.get('delete-task'))!;
    await runs.commitTerminal({
      runId: child.runId, attempt: child.attempt, expectedOwnerEpoch: child.owner!.epoch,
      expectedNextEventSeq: child.cursor.nextEventSeq, status: 'completed', terminalAt: now,
      event: { type: 'run_completed', payload: {}, recordedAt: now },
    });
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
