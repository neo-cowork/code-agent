import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const coordinatorState = vi.hoisted(() => ({ execute: vi.fn() }));
const factoryState = vi.hoisted(() => ({ create: vi.fn() }));
const loggerState = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
const sessionManagerState = vi.hoisted(() => ({ addMessageToSession: vi.fn() }));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: loggerState.info, warn: loggerState.warn, error: loggerState.error, debug: vi.fn() }),
}));
vi.mock('../../../src/host/agent/autoAgentCoordinator', () => ({
  getAutoAgentCoordinator: () => ({ execute: coordinatorState.execute }),
}));
vi.mock('../../../src/host/agent/dynamicAgentFactory', () => ({
  getDynamicAgentFactory: () => ({ create: factoryState.create }),
}));
vi.mock('../../../src/host/agent/agentRequirementsAnalyzer', () => ({
  getAgentRequirementsAnalyzer: () => ({ analyze: vi.fn() }),
}));
vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
}));
vi.mock('../../../src/host/scheduler/TaskDAG', () => ({
  TaskDAG: class { addAgentTask = vi.fn(); },
}));
vi.mock('../../../src/host/scheduler/dagEventBridge', () => ({ sendDAGInitEvent: vi.fn() }));
vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({ name: 'mock-tool-resolver' }),
}));

import { runAutoAgentMode } from '../../../src/host/agent/orchestrator/autoAgentRunner';

function makeTaskListManager() {
  return {
    reset: vi.fn(),
    createTask: vi.fn((input) => ({
      id: `task-${input.subject}`,
      subject: input.subject,
      description: input.description,
    })),
    getState: vi.fn(() => ({ requireApproval: false })),
    waitForApproval: vi.fn(),
    startExecution: vi.fn(),
    completeExecution: vi.fn(),
    failExecution: vi.fn(),
  };
}

function makeDeps() {
  return {
    requestPermission: vi.fn(async () => false),
    workingDirectory: '/tmp/project',
    sessionId: 'session-auto-1',
    sourceMessageId: 'message-auto-1',
    taskListManager: makeTaskListManager() as never,
    generateId: () => 'message-1',
    addMessage: vi.fn(),
    sendDAGStatusEvent: vi.fn(),
    runStandardAgentLoop: vi.fn(),
  };
}

function run(deps: ReturnType<typeof makeDeps>, onEvent: Parameters<typeof runAutoAgentMode>[3] = vi.fn()) {
  return runAutoAgentMode(
    'do the work',
    'do the work with context',
    { taskType: 'work', executionStrategy: 'sequential', confidence: 0.9 } as never,
    onEvent,
    { provider: 'mock', model: 'mock-model' } as never,
    deps,
    'session-auto-1',
  );
}

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { getApplicationRunRegistry, resetApplicationRunRegistryForTests } from '../../../src/host/app/applicationRunRegistry';
import { AutoAgentDurableRuntime, configureAutoAgentDurableRuntime } from '../../../src/host/agent/autoAgentDurableRuntime';
import { AgentTeamDurableRuntime, stableAgentTeamRunId } from '../../../src/host/agent/agentTeamDurableAdapter';
import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';
import { createRunTraceContext, withRunTraceContext } from '../../../src/host/telemetry/runTraceContext';
import { prepareNativeToolCheckpoint } from '../../../src/host/tools/nativeToolCheckpoint';
import { withNativeModelOperation } from '../../../src/host/agent/runtime/contextAssembly/nativeModelCheckpoint';
import { startRunPreferringDurable } from '../../../src/host/agent/orchestrator/durableRunStart';

const parentInput = { runId: 'run-parent', sessionId: 'session-auto-1', workspace: '/tmp/project' };
const trace = createRunTraceContext({ ...parentInput, attempt: 1, ownerEpoch: 0, engine: 'native', processInstanceId: 'lease-test' });

describe('parent ownership across follow-up and background completion', () => {
  let db: Database.Database;
  let repository: DurableRunRepository;
  let kernel: DurableRunKernel;
  let registry: ReturnType<typeof getApplicationRunRegistry>;
  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    repository = new DurableRunRepository(db);
    repository.migrate();
    kernel = new DurableRunKernel({ stores: repository, ownerId: 'host', processInstanceId: 'lease-test', leaseDurationMs: 60_000 });
    registry = getApplicationRunRegistry();
    registry.configureDurableKernel(kernel);
    configureAutoAgentDurableRuntime(new AutoAgentDurableRuntime(kernel, registry));
    factoryState.create.mockReturnValue([{ id: 'agent-worker', name: 'Worker', systemPrompt: 'Research the travel options', tools: ['Read'] }]);
    coordinatorState.execute.mockResolvedValue({ success: true, results: [], aggregatedOutput: 'completed output', totalDuration: 1, totalIterations: 1, totalCost: 0, errors: [] });
  });
  afterEach(() => {
    configureAutoAgentDurableRuntime(null);
    resetApplicationRunRegistryForTests();
    db.close();
  });

  it('A: completes auto-agent follow-up with a registered non-durable parent', async () => {
    // Persist a running parent, then release this process ownership: the follow-up
    // retains its run identity but must not mutate the owner's durable record.
    await registry.startDurable(parentInput);
    await registry.releaseDurable(parentInput.runId);
    registry.start(parentInput);
    const deps = makeDeps();
    const onEvent = vi.fn();
    factoryState.create.mockReturnValue(['rail', 'cycling'].map(id => ({ id, name: id, systemPrompt: `Research ${id}`, tools: ['Read'] })));
    await expect(withRunTraceContext(trace, () => run(deps, onEvent))).resolves.toBeUndefined();
    expect((await repository.get(parentInput.runId))?.status).not.toBe('failed');
    expect(await repository.get(parentInput.runId)).not.toBeNull();
    expect(registry.get(parentInput.runId)).toBeDefined();
    expect(loggerState.error).not.toHaveBeenCalled();
    expect(JSON.stringify([...onEvent.mock.calls, ...deps.addMessage.mock.calls, ...sessionManagerState.addMessageToSession.mock.calls, ...loggerState.error.mock.calls, ...loggerState.warn.mock.calls])).not.toMatch(/owner lease/i);
    expect(deps.addMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'completed output' }));
    expect(await repository.listChildRuns(parentInput.runId)).toEqual([]);
    expect(loggerState.info).toHaveBeenCalledWith(expect.stringContaining('durable start skipped'), expect.objectContaining({ reason: 'parent_owner_missing', parentRunId: parentInput.runId }));
    process.stdout.write(`A follow-up log: ${JSON.stringify(loggerState.info.mock.calls.find(call => call[1]?.reason === 'parent_owner_missing'))}\n`);
  });

  it('A diagnosis: session conflicts reject plain registration too, rather than creating an ownerless run', async () => {
    await registry.startDurable({ ...parentInput, runId: 'original-root' });
    await expect(startRunPreferringDurable(registry, parentInput)).rejects.toThrow('already has active run');
    expect(registry.get(parentInput.runId)).toBeUndefined();
  });

  it('A: a live parent still creates and completes a durable auto child', async () => {
    await registry.startDurable(parentInput);
    await withRunTraceContext(trace, () => run(makeDeps()));
    expect(await repository.listChildRuns(parentInput.runId)).toEqual([expect.objectContaining({ status: 'completed' })]);
  });

  it('A: a live parent preserves real durable preparation failures', async () => {
    await registry.startDurable(parentInput);
    const failure = new Error('storage unavailable');
    vi.spyOn(registry, 'prepareAgentTeamChild').mockRejectedValueOnce(failure);
    await expect(withRunTraceContext(trace, () => run(makeDeps()))).rejects.toBe(failure);
  });

  it('A sibling: agent team without a parent owner keeps approval and member lifecycle in memory', async () => {
    registry.start(parentInput);
    const runId = stableAgentTeamRunId(parentInput.runId, 'team-call');
    const task = { id: 'research', role: 'explore', task: 'Compare local rail routes', tools: ['Read'] };
    const runtime = new AgentTeamDurableRuntime(kernel, registry);
    const controller = await runtime.start({ parentRunId: parentInput.runId, logicalOperationId: 'team-call', scope: { runId, sessionId: parentInput.sessionId, treeId: runId }, tasks: [task], sideEffect: false });
    await controller.markApprovalWaiting('approval');
    expect(controller.getState().pendingApprovalRefs[0].status).toBe('waiting');
    await controller.resolveApproval('approval', 'approved');
    await controller.markNodeDispatched(task);
    await controller.markNodeTerminal(task, { taskId: task.id, role: task.role, success: true, output: 'Rail comparison ready', toolsUsed: [], iterations: 1, startTime: 1, endTime: 2, duration: 1 });
    await controller.terminal('completed');
    expect(controller.getState().taskGraph[0].status).toBe('completed');
    expect(controller.getState().runningChildRefs).toEqual([]);
    expect(await repository.get(runId)).toBeNull();
  });

  async function endParent(status: 'completed' | 'failed') {
    // The parent's own finalization settles outstanding operations before completion.
    if (status === 'completed') {
      const envelope = (await repository.get(parentInput.runId))!;
      await registry.checkpointDurable(parentInput.runId, { now: Date.now(), events: [{ type: 'parent_operations_settled', payload: {}, recordedAt: Date.now() }], status: 'running', state: { schemaVersion: 1, kind: 'native' }, pendingOperations: (envelope.pendingOperations ?? []).map(op => ({ ...op, status: 'abandoned' as const })) });
    }
    await registry.terminalDurable(parentInput.runId, { now: Date.now(), status, event: { type: `run_${status}`, payload: {}, recordedAt: Date.now() } });
  }

  it.each(['completed', 'failed'] as const)('B: late tool success survives a %s parent', async status => {
    await registry.startDurable(parentInput);
    const checkpoint = await prepareNativeToolCheckpoint({ runId: parentInput.runId, sourceMessageId: 'message-1', toolName: 'WebSearch', toolDefinition: { name: 'WebSearch', description: 'Research destinations', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: {} }, requiresPermission: false, permissionLevel: 'read' }, toolCallId: 'search', executionId: 'execution-search', startedAt: Date.now() });
    await endParent(status);
    await expect(checkpoint.complete(true)).resolves.toBeUndefined();
    expect(loggerState.info).toHaveBeenCalledWith(expect.stringContaining('checkpoint skipped'), expect.objectContaining({ reason: 'parent_run_not_durable', runId: parentInput.runId }));
    process.stdout.write(`B skip log: ${JSON.stringify(loggerState.info.mock.calls.find(call => call[1]?.reason === 'parent_run_not_durable'))}\n`);
  });

  it('B: a terminal queued between ownership check and completion is tolerated', async () => {
    await registry.startDurable(parentInput);
    const checkpoint = await prepareNativeToolCheckpoint({ runId: parentInput.runId, sourceMessageId: 'message-1', toolName: 'Read', toolDefinition: { name: 'Read', description: 'Read notes', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: {} }, requiresPermission: false, permissionLevel: 'read' }, executionId: 'read', startedAt: Date.now() });
    const terminal = registry.terminalDurable(parentInput.runId, { now: Date.now(), status: 'failed', event: { type: 'run_failed', payload: {}, recordedAt: Date.now() } });
    const completed = checkpoint.complete(true);
    await terminal;
    await expect(completed).resolves.toBeUndefined();
    expect(loggerState.info).toHaveBeenCalledWith(expect.stringContaining('checkpoint skipped'), expect.objectContaining({ reason: 'parent_run_not_durable' }));
  });

  it('B: a live owner does not hide a real tool checkpoint failure', async () => {
    await registry.startDurable(parentInput);
    const checkpoint = await prepareNativeToolCheckpoint({ runId: parentInput.runId, sourceMessageId: 'message-1', toolName: 'Read', toolDefinition: { name: 'Read', description: 'Read notes', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: {} }, requiresPermission: false, permissionLevel: 'read' }, executionId: 'read', startedAt: Date.now() });
    const failure = new Error('storage unavailable');
    vi.spyOn(registry, 'checkpointNativeToolOperation').mockRejectedValueOnce(failure);
    await expect(checkpoint.complete(true)).rejects.toBe(failure);
  });

  it('A sibling: auto child reaches terminal even after its parent failed', async () => {
    await registry.startDurable(parentInput);
    const runtime = new AutoAgentDurableRuntime(kernel, registry);
    const controller = await runtime.start({ parentRunId: parentInput.runId, sessionId: parentInput.sessionId, sourceMessageId: 'message-1', workspace: { root: '/tmp/project', cwd: '/tmp/project', fingerprint: 'project' }, graphId: 'graph', sideEffect: false });
    if (!controller) throw new Error('live parent must yield a durable auto child');
    await endParent('failed');
    await expect(controller.terminal('completed')).resolves.toBeUndefined();
    expect(await repository.get(controller.runId)).toMatchObject({ status: 'completed' });
  });

  it('B sibling: late model success preserves the result and logs missing ownership', async () => {
    await registry.startDurable(parentInput);
    const ctx = { runtime: { runId: parentInput.runId, messages: [{ role: 'user', id: 'message-1', content: 'Compare rail options' }], turn: { currentTurnId: 'model-turn' }, goalMode: null, control: { isCancelled: false, isInterrupted: false } } } as unknown as Parameters<typeof withNativeModelOperation>[0];
    const result = await withNativeModelOperation(ctx, { provider: 'test', model: 'test' } as never, new AbortController().signal, async () => { await endParent('completed'); return 'Rail summary'; });
    expect(result).toBe('Rail summary');
    expect(loggerState.info).toHaveBeenCalledWith(expect.stringContaining('checkpoint skipped'), expect.objectContaining({ reason: 'parent_run_not_durable', status: 'succeeded' }));
  });
});
