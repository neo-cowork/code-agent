import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const probe = vi.hoisted(() => ({ execute: vi.fn(), addMessage: vi.fn() }));
vi.mock('../../../src/host/agent/agentRequirementsAnalyzer', () => ({
  getAgentRequirementsAnalyzer: () => ({ analyze: async () => ({
    taskType: 'mixed', executionStrategy: 'sequential', confidence: 1, needsAutoAgent: true,
  }) }),
}));
vi.mock('../../../src/host/agent/dynamicAgentFactory', () => ({
  getDynamicAgentFactory: () => ({ create: () => [{
    id: 'worker', name: 'Worker', tools: ['Read'], systemPrompt: 'Summarize the result',
  }] }),
}));
vi.mock('../../../src/host/agent/autoAgentCoordinator', () => ({
  getAutoAgentCoordinator: () => ({ execute: probe.execute }),
}));
vi.mock('../../../src/host/services/wake/userReturn', () => ({ cancelTimeWakesOnUserReturn: vi.fn() }));
vi.mock('../../../src/host/session/sessionEventService', () => ({
  getSessionEventService: () => ({ saveEvent: vi.fn() }), startSessionEventLivenessProbe: vi.fn(),
}));
vi.mock('../../../src/host/services', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/services')>(),
  getSessionManager: () => ({
    addMessageToSession: probe.addMessage,
    getSession: async () => undefined,
  }),
}));
vi.mock('../../../src/host/agent/orchestrator/contextHealthSnapshot', () => ({ updateContextHealthSnapshot: vi.fn() }));
vi.mock('../../../src/host/telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/telemetry')>(),
  getTelemetryCollector: () => ({
    startSession: vi.fn(), endSession: vi.fn(), handleEvent: vi.fn(),
    updateSessionTitle: vi.fn(), getSessionData: () => undefined, createAdapter: () => undefined,
  }),
}));
vi.mock('../../../src/host/scheduler/dagEventBridge', () => ({ sendDAGInitEvent: vi.fn() }));

import { AgentOrchestrator } from '../../../src/host/agent/agentOrchestrator';
import { configureAutoAgentDurableRuntime } from '../../../src/host/agent/autoAgentDurableRuntime';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';
import { withRunTraceContext } from '../../../src/host/telemetry/runTraceContext';
import type { ConfigService } from '../../../src/host/services/core/configService';
import type { AgentEvent } from '../../../src/shared/contract';

// Real Orchestrator → auto runner → durable runtime → RunRegistry/kernel/SQLite.
// Only task planning, model execution, and host presentation services are replaced.
describe('automatic completion follow-up through AgentOrchestrator and real RunRegistry', () => {
  let db: Database.Database;
  let repository: DurableRunRepository;
  let registry: RunRegistry;
  let orchestrator: AgentOrchestrator;
  let events: AgentEvent[];
  let graphRunId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    repository = new DurableRunRepository(db);
    repository.migrate();
    registry = new RunRegistry();
    registry.configureDurableKernel(new DurableRunKernel({
      stores: repository, ownerId: 'test-host', processInstanceId: 'test-process', leaseDurationMs: 60_000,
    }));
    events = [];
    graphRunId = '';
    probe.execute.mockImplementation(async (_agents, _requirements, options) => {
      graphRunId = options.executionContext.runId;
      return {
        success: true, aggregatedOutput: 'The background result is ready.',
        totalIterations: 1, totalCost: 0, errors: [], results: [],
      };
    });
    orchestrator = new AgentOrchestrator({
      configService: {
        getSettings: () => ({ permissions: { autoApprove: { read: true, write: false, execute: false, network: false } } }),
        getApiKey: () => undefined,
        isDevModeAutoApproveEnabled: () => false,
      } as unknown as ConfigService,
      runRegistry: registry,
      hasApprovalUi: () => true,
      getHomeDir: () => '/tmp/auto-followup',
      onEvent: event => { events.push(event); },
    });
    orchestrator.setSessionId('session-followup');
  });

  afterEach(async () => {
    await orchestrator.drainWorkspaceServices();
    registry.clear();
    configureAutoAgentDurableRuntime(null);
    db.close();
  });

  async function foreground() {
    const handle = await registry.startDurable({
      runId: 'run-foreground', sessionId: 'session-followup', workspace: '/tmp/auto-followup',
    });
    if (!handle.traceContext) throw new Error('Missing real durable trace');
    return handle;
  }

  async function finishForeground() {
    const now = Date.now();
    await registry.terminalDurable('run-foreground', {
      now, status: 'completed', event: { type: 'run_completed', payload: {}, recordedAt: now },
    });
    registry.unregister('run-foreground');
  }

  it('completes with its own durable owner when the inherited foreground lease has ended', async () => {
    const handle = await foreground();
    await finishForeground();
    expect(registry.hasDurableOwner('run-foreground')).toBe(false);

    await withRunTraceContext(handle.traceContext!, () => orchestrator.sendMessage('Summarize the completed background result'));

    expect(probe.execute).toHaveBeenCalledTimes(1);
    expect(graphRunId).not.toBe('run-foreground');
    const graph = await repository.get(graphRunId);
    expect(graph).toMatchObject({ status: 'completed', owner: { processInstanceId: 'test-process' } });
    expect(graph).not.toHaveProperty('parentRunId');
    const parent = await repository.get('run-foreground');
    expect(parent).toMatchObject({ status: 'completed' });
    expect(parent?.childRuns ?? []).toEqual([]);
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'message', data: expect.objectContaining({ content: 'The background result is ready.' }),
    }));
  });

  it('preserves the child link and parent operation when the foreground owner is live', async () => {
    const handle = await foreground();

    await withRunTraceContext(handle.traceContext!, () => orchestrator.sendMessage('Summarize the background result'));

    expect(await repository.get(graphRunId)).toMatchObject({ status: 'completed', parentRunId: 'run-foreground' });
    expect((await repository.get('run-foreground'))?.pendingOperations).toEqual([
      expect.objectContaining({ kind: 'child_run', status: 'succeeded' }),
    ]);
    await finishForeground();
  });

  it('still reports an actual graph failure with an ended foreground lease', async () => {
    const handle = await foreground();
    await finishForeground();
    probe.execute.mockRejectedValue(new Error('graph failed'));

    await expect(withRunTraceContext(handle.traceContext!, () => orchestrator.sendMessage('Summarize the background result'))).rejects.toThrow('graph failed');

    expect(events).toContainEqual(expect.objectContaining({ type: 'error', data: expect.objectContaining({ message: 'graph failed' }) }));
  });

  it('uses the session approval handler when an automatic follow-up is refused', async () => {
    const handle = await foreground();
    await finishForeground();
    const result = {
      success: true, aggregatedOutput: 'The write was refused.',
      totalIterations: 1, totalCost: 0, errors: [], results: [],
    };
    probe.execute.mockImplementation(async (_agents, _requirements, options) => {
      const pending = options.executionContext.permission.request({
        sessionId: 'session-followup', tool: 'Write', type: 'file_write', forceConfirm: true,
        details: { path: '/work/outside/refused.txt' },
      });
      await vi.waitFor(() => expect(orchestrator.getPendingPermissionRequests()).toHaveLength(1));
      const request = orchestrator.getPendingPermissionRequests()[0];
      expect(request.details.path).toBe('/work/outside/refused.txt');
      expect(orchestrator.handlePermissionResponse(request.id, 'deny')).toBe('delivered');
      expect(await pending).toBe(false);
      return result;
    });

    await withRunTraceContext(handle.traceContext!, () => orchestrator.sendMessage('Summarize the background result'));

    expect(events).toContainEqual(expect.objectContaining({ type: 'permission_request' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'message', data: expect.objectContaining({ content: 'The write was refused.' }) }));
  });

});
