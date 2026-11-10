import { createScopedSwarmAgentId } from '../../../src/shared/contract/swarm';
import { getSubagentContextStore } from '../../../src/host/context/subagentContextStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import { createAgentDurableRouteRunLifecycle } from '../../../src/web/routes/agentDurableRouteLifecycle';
import { createRunContext, type RunHandle } from '../../../src/host/runtime/runContext';
import type { RunRegistry } from '../../../src/host/runtime/runRegistry';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';
import { buildAgentTreeSnapshot } from '../../../src/host/agent/agentTreeService';
import { buildAgentRows } from '../../../src/renderer/utils/agentRows';
import { finalizeOrParkDurableRun } from '../../../src/host/agent/orchestrator/durableRunTerminal';

function startChild(id: string, background: boolean, parentRunId = 'parent', parentId?: string) {
  let finish!: (result: SubagentResult) => void;
  const promise = new Promise<SubagentResult>((resolve) => { finish = resolve; });
  const controller = new AbortController();
  getSubagentContextStore().upsert({ sessionId: 'session', agentId: id, messages: [], updatedAt: Date.now() });
  getSpawnGuard().register(id, 'coder', 'Create the sales presentation', promise, controller, {
    treeId: 'session', parentRunId, parentId, background,
  });
  controller.signal.addEventListener('abort', () => finish({ success: false, output: '', toolsUsed: [], iterations: 0, cancellationReason: 'parent-cancel' }));
  return { controller, finish: () => finish({ success: true, output: 'Presentation ready', toolsUsed: [], iterations: 1 }), promise };
}
function workingCount() {
  const snapshot = buildAgentTreeSnapshot({ sessionId: 'session', spawnAgents: getSpawnGuard().list(), contextRecords: getSubagentContextStore().list('session') });
  return buildAgentRows({ members: [], nodes: snapshot.nodes, tasks: [] }).filter((row) => row.status === 'working').length;
}
function parent() {
  const handle: RunHandle = {
    context: createRunContext({ runId: 'parent', sessionId: 'session', workspace: '/workspace', cwd: '/workspace' }),
    isAttached: false, cancellationRequested: false,
    cancel: vi.fn(async () => {}), pause: vi.fn(async () => {}), resume: vi.fn(async () => {}),
    steer: vi.fn(async () => {}), attach: vi.fn(async () => {}),
  };
  const registry = {
    startDurable: vi.fn(async () => handle), supersedeParkedSessionRoots: vi.fn(async () => {}),
    terminalDurable: vi.fn(async () => {}), unregister: vi.fn(), getDurableCheckpointState: vi.fn(),
  } as unknown as RunRegistry;
  return { handle, registry, lifecycle: createAgentDurableRouteRunLifecycle({
    runRegistry: registry, sessionId: 'session', workspace: '/workspace', durableActivation: true,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }) };
}

beforeEach(() => { resetSpawnGuard(); getSubagentContextStore().clearSession('session'); });
afterEach(() => { resetSpawnGuard(); getSubagentContextStore().clearSession('session'); });
describe('production parent terminal and live child projection', () => {
  it.each(['exception', 'step-limit'] as const)('%s closes foreground children but preserves a real running background child until its own completion', async (ending) => {
    const { lifecycle } = parent();
    await lifecycle.start();
    const foreground = startChild('foreground', false);
    const background = startChild('background', true);
    const otherRun = startChild('other-run', false, 'other-parent');
    expect(workingCount()).toBe(3); // parent still running: all children untouched
    if (ending === 'exception') await lifecycle.markFailure({ disconnected: false, message: 'parent failed' });
    else await lifecycle.markSuccess({ finalStatus: 'error' }); // resolved MAX_ITERATIONS/forceFinalSeal error exit
    expect(foreground.controller.signal.aborted).toBe(true);
    expect(getSpawnGuard().get('foreground')?.status).toBe('cancelled');
    expect(background.controller.signal.aborted).toBe(false);
    expect(otherRun.controller.signal.aborted).toBe(false);
    expect(workingCount()).toBe(2);
    otherRun.finish();
    await otherRun.promise;
    expect(workingCount()).toBe(1);
    background.finish();
    await background.promise;
    expect(getSpawnGuard().get('background')?.status).toBe('completed');
    expect(workingCount()).toBe(0);
    const finalContext = getSubagentContextStore().get('session', 'background')!;
    const lateContext = { ...finalContext };
    delete lateContext.lifecycleStatus;
    getSubagentContextStore().upsert(lateContext); // a late executor context flush must not erase its actual terminal fact
    getSpawnGuard().cleanup(-1);
    expect(workingCount()).toBe(0); // completion survives guard cleanup in the same process; no recovery/restart or status rewrites
  });

  it('the orchestrator terminal uses the same foreground/background rule', async () => {
    const { registry, handle } = parent();
    const foreground = startChild('foreground', false);
    const background = startChild('background', true);
    await finalizeOrParkDurableRun({ registry, handle, runId: 'parent', sessionId: 'session', completed: false });
    expect(foreground.controller.signal.aborted).toBe(true);
    expect(background.controller.signal.aborted).toBe(false);
    background.finish();
    await background.promise;
    expect(workingCount()).toBe(0);
  });

  it('a parent cancel closes its background children too', async () => {
    const { lifecycle } = parent();
    await lifecycle.start();
    const background = startChild('background', true);
    await lifecycle.markFailure({ disconnected: true, message: 'cancelled' });
    expect(background.controller.signal.aborted).toBe(true);
    expect(workingCount()).toBe(0);
  });
  it('preserves foreground work awaited by a live background child, then closes it when that actual parent ends', async () => {
    const { lifecycle } = parent();
    await lifecycle.start();
    const background = startChild('background', true);
    const nested = startChild('nested-foreground', false, 'parent', 'background');
    await lifecycle.markFailure({ disconnected: false, message: 'primary failed' });
    expect(background.controller.signal.aborted).toBe(false);
    expect(nested.controller.signal.aborted).toBe(false);
    expect(workingCount()).toBe(2);
    background.finish();
    await background.promise;
    expect(nested.controller.signal.aborted).toBe(true);
    expect(workingCount()).toBe(0);
  });

  it('retains a foreground Team awaited across scopes by a live background parent, without granting cross-session control', async () => {
    const { lifecycle } = parent();
    await lifecycle.start();
    const background = startChild('background', true);
    const scope = { sessionId: 'session', runId: 'team', treeId: 'team', parentNativeRunId: 'parent' };
    const childId = createScopedSwarmAgentId(scope, 'team-child');
    const controller = new AbortController();
    const child = new Promise<SubagentResult>((resolve) => controller.signal.addEventListener('abort', () => resolve({ success: false, output: '', toolsUsed: [], iterations: 0 })));
    getSpawnGuard().register(childId, 'coder', 'Calculate sales metrics', child, controller, { scope, waiterAgentId: 'background' });
    const foreign = { ...scope, sessionId: 'foreign' };
    expect(() => getSpawnGuard().register(createScopedSwarmAgentId(foreign, 'foreign-child'), 'coder', 'Foreign task', child, new AbortController(), { scope: foreign, waiterAgentId: 'background' })).toThrow('Managed waiter session scope mismatch');
    await lifecycle.markFailure({ disconnected: false, message: 'primary failed' });
    expect(controller.signal.aborted).toBe(false);
    background.finish();
    await background.promise;
    expect(controller.signal.aborted).toBe(true);
    expect(getSpawnGuard().get(childId)?.status).toBe('cancelled');
  });

});
