import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => ({ getSession: async (id: string) => ({ id, title: 'Research' }) }),
  notificationService: { notifyTaskComplete: vi.fn() },
}));
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));
import Database from 'better-sqlite3';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';
import { registerSingleSpawnVisibility, resetSingleSpawnVisibilityRegistry } from '../../../src/host/agent/singleSpawnVisibilityRegistry';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import { getAgentTreeSnapshot } from '../../../src/host/agent/agentTreeService';
import { getBackgroundTaskManager, resetBackgroundTaskManager } from '../../../src/host/session/backgroundTaskManager';
import { settleBackgroundRunOnRejection } from '../../../src/host/task/backgroundTaskTerminal';
import { createScopedSwarmAgentId } from '../../../src/shared/contract/swarm';
import { BACKGROUND_TASK_CANCELLED } from '../../../src/shared/constants';
import { notificationService } from '../../../src/host/services';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';

afterEach(() => { resetSpawnGuard(); resetBackgroundTaskManager(); resetSingleSpawnVisibilityRegistry(); vi.clearAllMocks(); });

describe('parent terminal settles member and background panel together', () => {
  it.each([{ status: 'cancelled', standalone: false }, { status: 'failed', standalone: false }, { status: 'cancelled', standalone: true }, { status: 'failed', standalone: true }] as const)('$status parent (standalone=$standalone) cancels both running helpers and settles the panel entry', async ({ status, standalone }) => {
    const db = new Database(':memory:');
    const repository = new DurableRunRepository(db);
    repository.migrate();
    const registry = new RunRegistry();
    registry.configureDurableKernel(new DurableRunKernel({ stores: repository, ownerId: 'host', processInstanceId: 'cascade-test', leaseDurationMs: 60_000 }));
    const sessionId = 'cascade-session';
    const runId = 'cascade-parent';
    const guard = getSpawnGuard();
    const panel = getBackgroundTaskManager();
    const releases: Array<() => void> = [];
    try {
      await registry.startDurable({ runId, sessionId, workspace: '/tmp/project' });
      await panel.moveToBackground(sessionId);
      const scope = { sessionId, runId, treeId: sessionId };
      const helpers = ['rail', 'cycling'].map(topic => {
        const controller = new AbortController();
        const promise = new Promise<SubagentResult>(resolve => {
          const finish = () => resolve({ success: false, output: '', error: 'cancelled', toolsUsed: [], iterations: 0 });
          releases.push(finish);
          controller.signal.addEventListener('abort', finish, { once: true });
        });
        const id = standalone ? `helper-${topic}` : createScopedSwarmAgentId(scope, topic);
        guard.register(id, 'explore', `Research ${topic}`, promise, controller, standalone ? { treeId: sessionId } : { scope });
        if (standalone) registerSingleSpawnVisibility({ sessionId, runId: `single-${topic}`, treeId: sessionId, parentNativeRunId: runId }, id);
        return { id, controller, promise };
      });
      const otherController = new AbortController();
      const otherScope = { sessionId: 'unrelated-session', runId: 'unrelated-parent', treeId: 'unrelated-session' };
      const otherPromise = new Promise<SubagentResult>(resolve => releases.push(() => resolve({ success: true, output: 'done', toolsUsed: [], iterations: 0 })));
      guard.register(createScopedSwarmAgentId(otherScope, 'other'), 'explore', 'Unrelated work', otherPromise, otherController, { scope: otherScope });
      expect(getAgentTreeSnapshot({ sessionId }).summary.running).toBe(2);
      expect(panel.getAllTasks()).toEqual([expect.objectContaining({ status: 'running' })]);
      const childHandle = await registry.startAuxiliaryDurableChild({ runId: 'auxiliary-child', sessionId, workspace: '/tmp/project' }, runId);
      const cancelChild = vi.fn(async () => {
        await registry.terminalDurable(childHandle.context.runId, { status: 'cancelled', now: Date.now(), event: { type: 'run_cancelled', payload: {}, recordedAt: Date.now() } });
      });
      await childHandle.attach({ cancel: cancelChild });
      await registry.terminalDurable(runId, { status, now: Date.now(), event: { type: `run_${status}`, payload: {}, recordedAt: Date.now() } });
      expect(cancelChild).toHaveBeenCalledTimes(1);
      expect(await repository.get(childHandle.context.runId)).toMatchObject({ status: 'cancelled' });
      const tree = getAgentTreeSnapshot({ sessionId });
      expect(tree.nodes).toHaveLength(2);
      expect(tree.nodes.map(node => node.status)).toEqual(['cancelled', 'cancelled']);
      expect(tree.summary.running).toBe(0);
      expect(otherController.signal.aborted).toBe(false);
      expect(getAgentTreeSnapshot({ sessionId: otherScope.sessionId }).summary.running).toBe(1);
      expect(helpers.every(helper => helper.controller.signal.aborted)).toBe(true);
      if (status === 'cancelled') {
        expect(panel.getAllTasks()).toEqual([expect.objectContaining({ sessionId, status: 'completed', completionMessage: BACKGROUND_TASK_CANCELLED })]);
        expect(notificationService.notifyTaskComplete).toHaveBeenCalledTimes(1);
      } else {
        // A failed parent must leave the root entry to the TaskManager rejection path (real error, no "stopped").
        expect(notificationService.notifyTaskComplete).not.toHaveBeenCalled();
        settleBackgroundRunOnRejection(sessionId, 'provider exploded');
        expect(panel.getAllTasks()).toEqual([expect.objectContaining({ sessionId, status: 'failed', completionMessage: 'provider exploded' })]);
        expect(panel.getAllTasks()[0].completionMessage).not.toBe(BACKGROUND_TASK_CANCELLED);
        expect(notificationService.notifyTaskComplete).toHaveBeenCalledTimes(1);
        expect(notificationService.notifyTaskComplete).toHaveBeenCalledWith(expect.objectContaining({ sessionId, summary: expect.not.stringContaining('任务已停止') }), expect.anything());
      }
      expect(panel.getAllTasks().filter(task => task.status === 'running')).toHaveLength(0);
      process.stdout.write(`parent=${status} members=${JSON.stringify(tree.nodes.map(node => ({ id: node.id, status: node.status })))} running=${tree.summary.running} panel=${JSON.stringify(panel.getAllTasks())}\n`);
      await Promise.all(helpers.map(helper => helper.promise));
      expect(getAgentTreeSnapshot({ sessionId }).nodes.every(node => node.status === 'cancelled')).toBe(true);
      expect(notificationService.notifyTaskComplete).toHaveBeenCalledTimes(1);
    } finally {
      releases.forEach(release => release());
      registry.clear();
      db.close();
    }
  });
});
