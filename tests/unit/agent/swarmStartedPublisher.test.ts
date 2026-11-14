import { afterEach, expect, it, vi } from 'vitest';
import { getEventBus, shutdownEventBus } from '../../../src/host/services/eventing/bus';
import { SwarmEventEmitter } from '../../../src/host/agent/swarmEventPublisher';
import { SwarmTraceWriter } from '../../../src/host/agent/swarmTraceWriter';
import type { SwarmTraceRepo } from '../../../src/shared/contract/swarmTrace';
import { projectGraphEvent } from '../../../src/host/orchestration/graphEventCompatibilityAdapter';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
afterEach(() => { shutdownEventBus(); vi.clearAllMocks(); });

it('retains the first publisher and timestamp when another publisher repeats the same run', async () => {
  const repo = { startRun: vi.fn(), appendEvent: vi.fn() } as unknown as SwarmTraceRepo;
  const writer = new SwarmTraceWriter(repo);
  writer.install();
  const scope = { sessionId: 'session-sales', runId: 'single-child', treeId: 'tree-sales' };
  const emitter = new SwarmEventEmitter();
  vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(200);
  emitter.started(scope, 1, 'spawnAgent.run_in_background');
  emitter.started(scope, 1, 'executeSingleSpawnAgent');
  await writer.drain();
  expect(repo.startRun).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    'Ignoring duplicate swarm:started for session-sales/single-child',
    { existing: { startedAt: 100, source: 'spawnAgent.run_in_background' },
      duplicate: { startedAt: 200, source: 'executeSingleSpawnAgent' } },
  );
  await writer.dispose();
  vi.restoreAllMocks();
});

it('identifies graph compatibility publications without changing their scope', () => {
  const event = projectGraphEvent({ type: 'graph_started', graphId: 'tree-sales', runId: 'run-sales',
    sessionId: 'session-sales', attempt: 1, sequence: 1, timestamp: 100, data: {} });
  expect(event.swarm[0]).toMatchObject({ type: 'swarm:started', publisher: 'GraphEventCompatibilityAdapter',
    sessionId: 'session-sales', runId: 'run-sales', treeId: 'tree-sales', timestamp: 100 });
  expect(getEventBus()).toBeDefined();
});
