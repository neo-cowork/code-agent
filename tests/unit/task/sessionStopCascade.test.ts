// N-FIX-COMPOSER-STOP-BG-BROWSER-SUBAGENT-REDESIGN：一次 Stop 必须停掉会话的全部后台工作。
// 真 TaskManager + 真 SessionCommandCenter + 真 BackgroundSubagentRegistry；只在 LLM 循环
// （AgentOrchestrator）这条外部边界上放替身。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANCELLATION_TIMEOUTS } from '../../../src/shared/constants';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import { buildAgentTreeSnapshot } from '../../../src/host/agent/agentTreeService';

interface FakeOrchestrator {
  label: string;
  cancel: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<void>>>;
  finish: (outcome: 'resolve' | 'reject') => void;
}

const fakes = vi.hoisted(() => ({
  instances: [] as FakeOrchestrator[],
  cancelBehavior: 'settle' as 'settle' | 'never' | 'throw',
  neverCancelFor: new Set<string>(),
}));

const sessionManagerState = vi.hoisted(() => ({
  addMessageToSession: vi.fn(),
  updateMessage: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {
    private release: { resolve: () => void; reject: (e: Error) => void } | undefined;
    private readonly fake: FakeOrchestrator;
    constructor() {
      this.fake = {
        label: `orchestrator-${fakes.instances.length}`,
        finish: (outcome) => {
          if (outcome === 'resolve') this.release?.resolve();
          else this.release?.reject(new Error('boom'));
        },
        cancel: vi.fn(async () => {
          if (fakes.cancelBehavior === 'throw') throw new Error('cancel exploded');
          if (fakes.cancelBehavior === 'never' || fakes.neverCancelFor.has(this.fake.label)) {
            return new Promise<void>(() => undefined);
          }
          this.release?.resolve();
        }),
      };
      fakes.instances.push(this.fake);
    }
    sendMessage = () => new Promise<void>((resolve, reject) => { this.release = { resolve, reject }; });
    cancel = (...args: unknown[]) => this.fake.cancel(...args);
    setSessionId = vi.fn();
    setPlanningService = vi.fn();
    setMessages = vi.fn();
    setWorkingDirectory = vi.fn();
    setWorkspaceScopeAuthority = vi.fn();
    getMessages = () => [];
    getPendingPermissionRequests = () => [];
  },
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
  broadcastToRenderer: vi.fn(),
}));
vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
  notificationService: { notifyNeedsInput: vi.fn(), notifyTaskComplete: vi.fn() },
}));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManagerState,
}));
vi.mock('../../../src/host/task/backgroundTaskSessionContext', () => ({
  getBackgroundTaskSessionContext: (sessionId: string) => sessionManagerState.getSession(sessionId),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: true, updateSession: vi.fn() }),
}));

import { TaskManager } from '../../../src/host/task/TaskManager';
import { SessionCommandCenter, type SessionCommandTask } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { getBackgroundTaskLedger, resetBackgroundTaskLedgerForTest } from '../../../src/host/task/backgroundTaskLedger';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import { createScopedSwarmAgentId } from '../../../src/shared/contract/swarm';
import { registerSwarmServices, resetSwarmServices } from '../../../src/host/agent/swarmServices';
import { getBackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

const PROJECT_SCOPE = createWorkspaceScope('test-project', [{
  sourceId: 'test-source',
  path: '/tmp/project',
  role: 'primary',
  access: 'read_write',
}]);

function spawnInput(sessionId: string, index: number, extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    title: `浏览器巡检 ${index}`,
    shortName: `巡检${index}`,
    laneKey: `lane-${sessionId}-${index}`,
    submissionKey: `submission-${sessionId}-${index}`,
    prompt: `盯住 example.org ${index}`,
    workspaceScope: PROJECT_SCOPE,
    ...extra,
  };
}

describe('TaskManager.cancelTask 后台级联', () => {
  let manager: TaskManager;
  let center: SessionCommandCenter;
  const projectTerminalResult = vi.fn();
  const wakeForegroundBrain = vi.fn();

  const taskOf = (sessionId: string, id: string): SessionCommandTask => {
    const task = center.list(sessionId).find((candidate) => candidate.id === id);
    if (!task) throw new Error(`missing task ${id}`);
    return task;
  };
  async function spawnRunning(sessionId: string, index: number): Promise<string> {
    const spawned = await center.spawn(spawnInput(sessionId, index));
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');
    await vi.waitFor(() => expect(manager.getBackgroundTaskState(spawned.task.id)?.status).toBe('running'));
    return spawned.task.id;
  }

  beforeEach(() => {
    fakes.instances.length = 0;
    fakes.cancelBehavior = 'settle';
    fakes.neverCancelFor.clear();
    projectTerminalResult.mockReset().mockResolvedValue(undefined);
    wakeForegroundBrain.mockReset().mockResolvedValue(undefined);
    sessionManagerState.getSession.mockReset().mockResolvedValue({ messages: [], workingDirectory: '/tmp/project' });
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
    manager = new TaskManager({ maxConcurrentTasks: 2 });
    manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
    center = new SessionCommandCenter(manager, { projectTerminalResult, wakeForegroundBrain });
  });

  afterEach(() => {
    center.dispose();
    vi.useRealTimers();
  });

  it('前台 idle（委派后的常态）：一次 cancelTask 停掉本会话全部后台任务，别的会话不受影响', async () => {
    const first = await spawnRunning('session-a', 1);
    const second = await spawnRunning('session-a', 2);
    const other = await spawnRunning('session-b', 1);

    expect(manager.getSessionState('session-a').status).toBe('idle');
    await manager.cancelTask('session-a');

    const aborted = fakes.instances.filter((fake) => fake.cancel.mock.calls.length > 0);
    expect(aborted).toHaveLength(2);
    await vi.waitFor(() => {
      expect(taskOf('session-a', first).status).toBe('cancelled');
      expect(taskOf('session-a', second).status).toBe('cancelled');
    });
    expect(taskOf('session-b', other).status).toBe('running');
    expect(getBackgroundTaskLedger().getTask(first)).toMatchObject({ status: 'cancelled' });
    expect(projectTerminalResult).toHaveBeenCalledWith(expect.objectContaining({ id: first }), 'cancelled');
    expect(wakeForegroundBrain).toHaveBeenCalledWith(expect.objectContaining({ id: first }), 'cancelled');
  });

  it('前台仍在运行：前台 orchestrator 与后台任务都被 abort', async () => {
    fakes.cancelBehavior = 'settle';
    const background = await spawnRunning('session-a', 1);
    const foreground = manager.startTask('session-a', '帮我盯着 example.org');
    await vi.waitFor(() => expect(manager.getSessionState('session-a').status).toBe('running'));
    const foregroundFake = fakes.instances.at(-1)!;

    await manager.cancelTask('session-a');
    await foreground.catch(() => undefined);

    expect(foregroundFake.cancel).toHaveBeenCalledTimes(1);
    expect(fakes.instances[0].cancel).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(taskOf('session-a', background).status).toBe('cancelled'));
  });

  it('永不收线的后台取消不拖延前台 abort，cancelTask 在上限内返回并 warn 未收线任务', async () => {
    const stuck = await spawnRunning('session-a', 1);
    const healthy = await spawnRunning('session-a', 2);
    fakes.neverCancelFor.add(fakes.instances[0].label);
    const foreground = manager.startTask('session-a', '继续盯');
    await vi.waitFor(() => expect(manager.getSessionState('session-a').status).toBe('running'));
    const foregroundFake = fakes.instances.at(-1)!;

    vi.useFakeTimers();
    const cancelled = manager.cancelTask('session-a');
    // 前台 abort 与全部后台 abort 都在同一同步段内发出，不需要推进任何计时器。
    expect(foregroundFake.cancel).toHaveBeenCalledTimes(1);
    expect(fakes.instances[0].cancel).toHaveBeenCalledTimes(1);
    expect(fakes.instances[1].cancel).toHaveBeenCalledTimes(1);

    let returned = false;
    void cancelled.then(() => { returned = true; });
    await vi.advanceTimersByTimeAsync(CANCELLATION_TIMEOUTS.SESSION_BACKGROUND_SETTLE_WAIT - 1);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await cancelled;
    expect(returned).toBe(true);
    vi.useRealTimers();
    await foreground.catch(() => undefined);
    await vi.waitFor(() => expect(taskOf('session-a', healthy).status).toBe('cancelled'));
    expect(taskOf('session-a', stuck).status).not.toBe('cancelled');
  });

  it('keepBackground（切会话/改道/收尾）不是用户 Stop：后台任务不被动', async () => {
    const id = await spawnRunning('session-a', 1);

    await manager.cancelTask('session-a', { keepBackground: true });

    expect(fakes.instances[0].cancel).not.toHaveBeenCalled();
    expect(taskOf('session-a', id).status).toBe('running');
  });

  it('某个任务取消抛错：其余任务照常被 abort，cancelTask 不抛', async () => {
    await spawnRunning('session-a', 1);
    await spawnRunning('session-a', 2);
    fakes.cancelBehavior = 'throw';

    await expect(manager.cancelTask('session-a')).resolves.toBeUndefined();
    expect(fakes.instances[0].cancel).toHaveBeenCalledTimes(1);
    expect(fakes.instances[1].cancel).toHaveBeenCalledTimes(1);
  });

  it('排队中的任务随 Stop 一起取消，且不会被前序任务收线后放行启动', async () => {
    const queuedSpawn = async (index: number) => {
      const result = await center.spawn(spawnInput('session-a', index, { queueWhenFull: true }));
      if (result.outcome === 'requires_choice') throw new Error('unexpected admission result');
      return result;
    };
    await queuedSpawn(1);
    await queuedSpawn(2);
    const third = await queuedSpawn(3);
    expect(third.task.status).toBe('queued');
    const startedBefore = fakes.instances.length;

    await manager.cancelTask('session-a');

    await vi.waitFor(() => expect(taskOf('session-a', third.task.id).status).toBe('cancelled'));
    expect(fakes.instances.length).toBe(startedBefore);
  });

  it('run_in_background 子代理（BackgroundSubagentRegistry）一并 abort', async () => {
    const abortA = vi.fn();
    const abortOther = vi.fn();
    const registry = getBackgroundSubagentRegistry();
    let finish: (() => void) | undefined;
    const agentId = registry.spawn(() => new Promise((resolve) => {
      finish = () => resolve({ success: true, output: '', toolsUsed: [], iterations: 0 } as never);
    }), { sessionId: 'session-reg-a', abort: () => { abortA(); finish?.(); } });
    registry.spawn(() => new Promise(() => undefined), { sessionId: 'session-reg-b', abort: abortOther });

    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await manager.cancelTask('session-reg-a');

    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortOther).not.toHaveBeenCalled();
    expect(registry.listBySession('session-reg-a').find((h) => h.agentId === agentId)?.status).not.toBe('running');
  });

  it('SpawnGuard 登记的 detached/adopted spawn_agent 子代理随 Stop 取消，别的会话的不受影响（web 路由与桌面共用）', async () => {
    resetSpawnGuard();
    const guard = getSpawnGuard();
    const planCancel = vi.fn();
    registerSwarmServices({
      spawnGuard: guard,
      planApproval: { cancelSession: planCancel },
      launchApproval: { cancelSession: vi.fn() },
      parallelCoordinators: { abortSession: vi.fn() },
    } as never);
    try {
      const scopeA = { sessionId: 'session-sg-a', runId: 'run-a', treeId: 'tree-a' };
      const scopeB = { sessionId: 'session-sg-b', runId: 'run-b', treeId: 'tree-b' };
      const controllerA = new AbortController();
      const controllerB = new AbortController();
      const pending = new Promise<never>(() => undefined);
      guard.register(createScopedSwarmAgentId(scopeA, 'agent_adopted_0'), 'coder', '盯网页', pending, controllerA, { scope: scopeA });
      guard.register(createScopedSwarmAgentId(scopeB, 'agent_adopted_0'), 'coder', '盯网页', pending, controllerB, { scope: scopeB });

      await manager.cancelTask('session-sg-a');

      expect(controllerA.signal.aborted).toBe(true);
      expect(controllerB.signal.aborted).toBe(false);
      expect(planCancel).toHaveBeenCalledWith('session-sg-a', 'user-cancel');

      const keep = new AbortController();
      const scopeC = { sessionId: 'session-sg-c', runId: 'run-c', treeId: 'tree-c' };
      guard.register(createScopedSwarmAgentId(scopeC, 'agent_adopted_0'), 'coder', 't', pending, keep, { scope: scopeC });
      await manager.cancelTask('session-sg-c', { keepBackground: true });
      expect(keep.signal.aborted).toBe(false);
    } finally {
      resetSwarmServices();
    }
  });

  it('自然失败仍是 failed，不被当成用户取消', async () => {
    const id = await spawnRunning('session-a', 1);
    fakes.instances[0].finish('reject');
    await vi.waitFor(() => expect(taskOf('session-a', id).status).toBe('failed'));
    expect(projectTerminalResult).toHaveBeenCalledWith(expect.objectContaining({ id }), 'failed');
    expect(getBackgroundTaskLedger().getTask(id)).toMatchObject({ status: 'failed' });
  });

  it('用户取消的后台子代理投影为 cancelled，真实失败仍是 failed', () => {
    const snapshot = buildAgentTreeSnapshot({
      now: 1000,
      sessionId: 'session-1',
      backgroundAgents: [
        { agentId: 'bg-stopped', status: 'failed', startedAt: 10, finishedAt: 20, error: 'aborted', failureCode: AgentFailureCode.CancelledByUser },
        { agentId: 'bg-broken', status: 'failed', startedAt: 10, finishedAt: 20, error: 'model exploded', failureCode: AgentFailureCode.ModelError },
      ],
    });
    const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
    expect(byId.get('bg-stopped')?.status).toBe('cancelled');
    expect(byId.get('bg-stopped')?.lastEvent?.summary).not.toContain('遇到问题');
    expect(byId.get('bg-broken')?.status).toBe('failed');
  });
});
