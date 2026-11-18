// 经生产入口 getAgentTreeSnapshot 验证：非 legacy 作用域的并行协调器成员必须进会话快照
// （N-FIX-AGENT-TREE-EMPTY-PARALLEL-SPAWN）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAgentTreeSnapshot } from '../../../src/host/agent/agentTreeService';
import {
  getParallelAgentCoordinatorRegistry,
  resetParallelAgentCoordinators,
} from '../../../src/host/agent/parallelAgentCoordinatorRegistry';
import { resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import type { AgentTask } from '../../../src/host/agent/parallelAgentCoordinatorTypes';
import { createScopedSwarmAgentId, type SwarmRunScope } from '../../../src/shared/contract/swarm';

// 与 spawnAgent 生产路径一致：成员 id 带运行作用域前缀，dependsOn 同样。
function task(scope: SwarmRunScope, id: string, role: string, dep?: string): AgentTask {
  return {
    id: createScopedSwarmAgentId(scope, id),
    role,
    task: `do ${id}`,
    tools: ['Read'],
    ...(dep ? { dependsOn: [createScopedSwarmAgentId(scope, dep)] } : {}),
  };
}
const sid = (scope: SwarmRunScope, id: string) => createScopedSwarmAgentId(scope, id);

function startRun(
  scope: SwarmRunScope,
  tasks: AgentTask[],
  execute: (...args: unknown[]) => Promise<unknown>,
  maxParallelTasks = 1,
) {
  const coordinator = getParallelAgentCoordinatorRegistry().getOrCreate(scope, {
    maxParallelTasks,
    taskTimeout: 5000,
    aggregateResults: false,
  });
  coordinator.initialize({
    executionContext: {
      sessionId: scope.sessionId,
      cwd: '/tmp',
      modelConfig: { provider: 'mock', model: 'mock-model' },
      resolver: { getDefinition: vi.fn() },
      permission: { request: async () => true },
      events: { emit: vi.fn() },
      abortSignal: new AbortController().signal,
      currentToolCallId: 'call-1',
    } as never,
    subagentExecutor: { execute } as never,
    scope,
  });
  return coordinator.executeParallel(tasks);
}

const scopeA: SwarmRunScope = { sessionId: 'sess-a', runId: 'run-a', treeId: 'tree-a' };
const scopeB: SwarmRunScope = { sessionId: 'sess-b', runId: 'run-b', treeId: 'tree-b' };

describe('getAgentTreeSnapshot with a run-scoped parallel coordinator', () => {
  beforeEach(() => {
    resetParallelAgentCoordinators();
    resetSpawnGuard();
  });

  it('shows members queued behind a slot or dependency, not only the running one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { success: true, output: 'ok', toolsUsed: [], iterations: 1 };
    });
    const run = startRun(scopeA, [
      task(scopeA, 'm1', 'reader'),
      task(scopeA, 'm2', 'writer'),
      task(scopeA, 'm3', 'reviewer', 'm1'),
    ], execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());

    const snapshot = getAgentTreeSnapshot({ sessionId: 'sess-a' });
    expect(snapshot.nodes.map((n) => n.id).sort()).toEqual(['m1', 'm2', 'm3'].map((m) => sid(scopeA, m)).sort());
    expect(snapshot.nodes.find((n) => n.id === sid(scopeA, 'm3'))?.role).toBe('reviewer');

    release();
    await run;
  });

  it('keeps members of a finalized scope after the live coordinator is gone', async () => {
    const run = startRun(scopeA, [task(scopeA, 'm1', 'reader'), task(scopeA, 'm2', 'writer')], async () => ({
      success: true, output: 'ok', toolsUsed: [], iterations: 1,
    }));
    await run;
    getParallelAgentCoordinatorRegistry().finalize(scopeA, 'completed');
    resetSpawnGuard();

    const snapshot = getAgentTreeSnapshot({ sessionId: 'sess-a' });
    expect(snapshot.nodes.map((n) => n.id).sort()).toEqual(['m1', 'm2'].map((m) => sid(scopeA, m)).sort());
    expect(snapshot.nodes.map((n) => n.status)).toEqual(['completed', 'completed']);
  });

  it('settles members still queued/running when the run is finalized as cancelled', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { success: true, output: 'ok', toolsUsed: [], iterations: 1 };
    });
    const run = startRun(scopeA, [task(scopeA, 'm1', 'reader'), task(scopeA, 'm2', 'writer')], execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());

    getParallelAgentCoordinatorRegistry().finalize(scopeA, 'cancelled');
    resetSpawnGuard();

    const snapshot = getAgentTreeSnapshot({ sessionId: 'sess-a' });
    expect(snapshot.nodes.map((n) => n.status)).toEqual(['cancelled', 'cancelled']);

    release();
    await run.catch(() => undefined);
  });

  it("does not leak another session's members", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { success: true, output: 'ok', toolsUsed: [], iterations: 1 };
    });
    const runA = startRun(scopeA, [task(scopeA, 'a1', 'reader'), task(scopeA, 'a2', 'writer')], execute);
    const runB = startRun(scopeB, [task(scopeB, 'b1', 'reader'), task(scopeB, 'b2', 'writer')], execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());

    const ids = (sessionId: string) => getAgentTreeSnapshot({ sessionId }).nodes.map((n) => n.id).sort();
    expect(ids('sess-a')).toEqual(['a1', 'a2'].map((m) => sid(scopeA, m)).sort());
    expect(ids('sess-b')).toEqual(['b1', 'b2'].map((m) => sid(scopeB, m)).sort());

    release();
    await Promise.all([runA, runB]);
  });
});
