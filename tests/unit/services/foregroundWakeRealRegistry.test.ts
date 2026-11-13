import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import type { TaskManager, TaskManagerEvent } from '../../../src/host/task/TaskManager';
import { initTaskManager, resetTaskManager } from '../../../src/host/task/TaskManager';
import type { AgentEvent, Message } from '../../../src/shared/contract';
import type { ConfigService } from '../../../src/host/services/core/configService';
import { AgentOrchestrator } from '../../../src/host/agent/agentOrchestrator';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';
import { startRunPreferringDurable } from '../../../src/host/agent/orchestrator/durableRunStart';
import { createForegroundWake, type ForegroundWakeDependencies } from '../../../src/host/services/commandCenter/foregroundWake';
import { SessionCommandCenter, type SessionCommandTask } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { resetBackgroundTaskLedgerForTest } from '../../../src/host/task/backgroundTaskLedger';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import type { AgentRunOptions } from '../../../src/host/research/types';
import { isTerminalAgentError } from '../../../src/shared/utils/agentErrorClassification';

// N-FIX-BG-TASK-WAKE-NO-OWNER-LEASE：真 RunRegistry（带 durable kernel）+ 真 createForegroundWake +
// 真 SessionCommandCenter。TaskManager / Orchestrator 只替换到「注册 run」这一步，注册走产线同一个
// startRunPreferringDurable，所以 owner lease 的有无和线上一致。

const SESSION = 'session-wake';
const SCOPE = createWorkspaceScope('project-wake', [{
  sourceId: 'source-wake', path: '/tmp/wake-project', role: 'primary', access: 'read_write',
}]);

class FakeTaskManager extends EventEmitter {
  startFailures: Error[] = [];
  settleFailures: Error[] = [];
  state: { status: string } = { status: 'idle' };
  private readonly handlesByTaskId = new Map<string, ReturnType<RunRegistry['start']>>();
  constructor(private readonly registry: RunRegistry) { super(); }

  startBackgroundTask = vi.fn(async (taskId: string, sessionId: string, _m: string, _a: unknown, options?: AgentRunOptions) => {
    try {
      const handle = await startRunPreferringDurable(
        this.registry,
        { runId: taskId, sessionId, workspace: '/tmp/wake-project' },
        'auxiliary',
        options?.parentRunId,
      );
      this.handlesByTaskId.set(taskId, handle);
    } catch (error) {
      this.startFailures.push(error as Error);
      throw error;
    }
  });
  interruptBackgroundTask = vi.fn().mockResolvedValue(true);
  cancelBackgroundTask = vi.fn().mockResolvedValue(true);
  emitTask(event: TaskManagerEvent): void {
    const taskId = (event.data as { taskId?: string } | undefined)?.taskId;
    if (taskId && (event.type === 'task_completed' || event.type === 'task_error' || event.type === 'task_cancelled')) {
      try {
        const handle = this.handlesByTaskId.get(taskId);
        if (handle) {
          this.registry.unregister(taskId, handle);
          this.handlesByTaskId.delete(taskId);
        }
      } catch (error) {
        this.settleFailures.push(error as Error);
      }
    }
    this.emit(event.type, event);
  }
  // 以下是 foregroundWake 依赖的 TaskManager 面
  getSessionState(): { status: string } { return this.state; }
  getWaitingQueue(): string[] { return []; }
  hasActivePrimaryRun(sessionId: string): boolean { return this.registry.hasSession(sessionId); }
  onRunIdle(listener: () => void): () => void { return this.registry.onIdleTransition(listener); }
  emitAgentEventForSession = vi.fn();
  observeAgentEvents = vi.fn(() => () => undefined);
  setSessionContext = vi.fn();
  setWorkingDirectory = vi.fn();
}

function makeRegistry(): { registry: RunRegistry; db: Database.Database } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const repository = new DurableRunRepository(db);
  repository.migrate();
  const registry = new RunRegistry();
  registry.configureDurableKernel(new DurableRunKernel({
    stores: repository, ownerId: 'test-host', processInstanceId: 'test-process', leaseDurationMs: 60_000,
  }));
  return { registry, db };
}

const session = {
  id: SESSION, title: '会话', modelConfig: { provider: 'openai', model: 'test' }, type: 'chat' as const,
  workingDirectory: '/tmp/wake-project', createdAt: 1, updatedAt: 1,
  messages: [{ id: 'user-1', role: 'user' as const, content: '开始', timestamp: 1 }],
  todos: [], messageCount: 1,
};

describe('background task settlement wake with a real RunRegistry', () => {
  let db: Database.Database;
  let registry: RunRegistry;
  let manager: FakeTaskManager;
  let center: SessionCommandCenter;
  let warn: Mock<(message: string, details?: unknown) => void>;
  let info: Mock<(message: string, details?: unknown) => void>;
  let queued: boolean;
  let wakeBody: (options: AgentRunOptions) => Promise<void>;
  let wakeSends: number;

  beforeEach(() => {
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
    ({ registry, db } = makeRegistry());
    manager = new FakeTaskManager(registry);
    warn = vi.fn<(message: string, details?: unknown) => void>();
    info = vi.fn<(message: string, details?: unknown) => void>();
    queued = false;
    wakeSends = 0;
    wakeBody = async () => undefined;
    const orchestrator = {
      isProcessing: () => false,
      // 与 AgentOrchestrator.sendMessage 同一注册路径：auxiliary 且无 parentRunId → 非 durable
      sendMessage: vi.fn(async (_p: string, _a: unknown, options: AgentRunOptions) => {
        wakeSends += 1;
        const handle = await startRunPreferringDurable(
          registry,
          { runId: `wake-run-${wakeSends}`, sessionId: SESSION, workspace: '/tmp/wake-project' },
          options.runRegistration,
          options.parentRunId,
        );
        (options as AgentRunOptions & { __wakeRunId?: string }).__wakeRunId = handle.context.runId;
        await wakeBody(options);
      }),
    };
    const deps: ForegroundWakeDependencies = {
      getTaskManager: () => ({
        ...manager,
        getSessionState: () => manager.getSessionState(),
        getWaitingQueue: () => [],
        hasActivePrimaryRun: (sessionId: string) => manager.hasActivePrimaryRun(sessionId),
        onRunIdle: (listener: () => void) => manager.onRunIdle(listener),
        getOrCreateCurrentOrchestrator: () => orchestrator,
        setSessionContext: manager.setSessionContext,
        setWorkingDirectory: manager.setWorkingDirectory,
        on: manager.on.bind(manager),
        off: manager.off.bind(manager),
        emitAgentEventForSession: manager.emitAgentEventForSession,
        observeAgentEvents: manager.observeAgentEvents,
      }) as unknown as ReturnType<ForegroundWakeDependencies['getTaskManager']>,
      loadSession: async () => session,
      hasQueuedUserInput: () => queued,
      isVoiceSession: () => false,
      recordWakeFailureNote: async () => undefined,
      recordWakeDeferredNote: async () => undefined,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      logger: { info, warn },
    };
    center = new SessionCommandCenter(manager as unknown as TaskManager, {
      projectTerminalResult: vi.fn(),
      wakeForegroundBrain: createForegroundWake(deps),
    });
  });

  afterEach(() => {
    center.dispose();
    registry.clear();
    db.close();
  });

  async function startForegroundWithTask(): Promise<SessionCommandTask> {
    const foreground = await registry.startDurable({ runId: 'run-fg', sessionId: SESSION, workspace: '/tmp/wake-project' }, 100);
    const spawned = await center.spawn({
      sessionId: SESSION, title: '任务一', shortName: '任务一', laneKey: 'lane-1', submissionKey: 'sub-1',
      prompt: '做点事', workspaceScope: SCOPE, parentRunId: 'run-fg',
    });
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected');
    await vi.waitFor(() => expect(manager.startBackgroundTask).toHaveBeenCalledTimes(1));
    // 前台轮在任务结束前就收尾了（和线上一致：任务是后台的）
    registry.unregister('run-fg', foreground);
    return spawned.task;
  }

  function settle(task: SessionCommandTask, conclusion = '任务一的结果'): void {
    manager.emitTask({ type: 'task_completed', sessionId: SESSION, data: { taskId: task.id, conclusion } } as TaskManagerEvent);
  }

  it('wake turn that spawns a follow-up task does not hit "no live owner lease"', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let followUpTask: SessionCommandTask | undefined;
    let followUpStatus: string | undefined;
    let wakeRunIdObserved: string | undefined;
    wakeBody = async (options) => {
      if (wakeSends > 1) return;
      const wakeRunId = (options as AgentRunOptions & { __wakeRunId?: string }).__wakeRunId;
      wakeRunIdObserved = wakeRunId;
      // delegate_task 工具把 ctx.runId（= 唤醒轮 run id）作为 parentRunId 传下去
      const spawned = await center.spawn({
        sessionId: SESSION, title: '续作', shortName: '续作', laneKey: 'lane-2', submissionKey: 'sub-2',
        prompt: '继续', workspaceScope: SCOPE, parentRunId: wakeRunId,
      });
      if (spawned.outcome !== 'requires_choice') {
        followUpTask = spawned.task;
        followUpStatus = spawned.task.status;
      }
    };
    try {
      const task = await startForegroundWithTask();
      settle(task);
      await vi.waitFor(() => expect(manager.startBackgroundTask.mock.calls.length).toBeGreaterThanOrEqual(2));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(followUpStatus).toBe('running');
      expect(followUpTask).toBeDefined();
      expect(registry.get(followUpTask!.id)).toBeDefined();

      // 唤醒轮本身以 auxiliary 注册（无 owner lease），续作任务的 parentRunId 就是唤醒轮 id，
      // startRunPreferringDurable 走 INFO 回落而非 WARN。
      const secondTaskCall = manager.startBackgroundTask.mock.calls[1];
      expect(secondTaskCall?.[4]?.parentRunId).toBe(wakeRunIdObserved);
      expect(wakeRunIdObserved).toBe('wake-run-1');
      expect(registry.hasDurableOwner('wake-run-1')).toBe(false);
      expect(registry.get('wake-run-1')).toBeDefined();

      const fallbackCalls = stderrSpy.mock.calls.filter((call) =>
        String(call[0]).includes('Parent run has no live owner lease, starting auxiliary run without durable parent link'),
      );
      expect(fallbackCalls).toHaveLength(1);
      expect(String(fallbackCalls[0]?.[0])).toContain(' INFO [DurableRunStart] Parent run has no live owner lease');
      expect(String(fallbackCalls[0]?.[0])).not.toContain(' WARN ');
      expect(fallbackCalls[0]?.[1]).toMatchObject({
        sessionId: SESSION,
        parentRunId: 'wake-run-1',
        parentRegistered: true,
        parentHasSession: false,
        reason: 'parent_run_not_durable',
      });

      // 驱动续作任务走到终态：收尾后状态为 completed、registry 句柄已释放、无启动或收尾失败。
      settle(followUpTask!, '续作的结果');
      await vi.waitFor(() => {
        const settled = center.list(SESSION).find((t) => t.id === followUpTask!.id);
        expect(settled?.status).toBe('completed');
      });
      const settledFollowUp = center.list(SESSION).find((t) => t.id === followUpTask!.id);
      expect(settledFollowUp?.summary).toContain('续作的结果');
      expect(registry.get(followUpTask!.id)).toBeUndefined();
      expect(manager.startFailures.map((e) => e.stack ?? e.message)).toEqual([]);
      expect(manager.settleFailures.map((e) => e.stack ?? e.message)).toEqual([]);
      expect(warn.mock.calls.map((c) => String(c[0]))).not.toContain('Foreground wake failed');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('uses startAuxiliaryDurableChild without fallback log when parent has a live owner lease', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const parent = await registry.startDurable(
        { runId: 'run-fg-durable', sessionId: SESSION, workspace: '/tmp/wake-project' },
        100,
      );
      expect(registry.hasDurableOwner('run-fg-durable')).toBe(true);

      const child = await startRunPreferringDurable(
        registry,
        { runId: 'child-durable', sessionId: SESSION, workspace: '/tmp/wake-project' },
        'auxiliary',
        'run-fg-durable',
      );
      expect(child.context.runId).toBe('child-durable');
      expect(registry.hasDurableOwner('child-durable')).toBe(true);
      expect(registry.getDurableEnvelope('child-durable')?.parentRunId).toBe('run-fg-durable');

      const fallbackCalls = stderrSpy.mock.calls.filter((call) =>
        String(call[0]).includes('Parent run has no live owner lease'),
      );
      expect(fallbackCalls).toEqual([]);

      registry.unregister('child-durable', child);
      registry.unregister('run-fg-durable', parent);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('defers the wake while a foreground run is active and delivers it when that run leaves the registry', async () => {
    const task = await startForegroundWithTask();
    // 前台模型正在轮询 task_status：一个真 primary run 占着会话
    const polling = registry.start({ runId: 'run-fg-polling', sessionId: SESSION, workspace: '/tmp/wake-project' });
    settle(task);
    await vi.waitFor(() => expect(info.mock.calls.map((c) => String(c[0]))).toContain('Foreground wake deferred: session busy'));
    expect(wakeSends).toBe(0);

    registry.unregister('run-fg-polling', polling);
    await vi.waitFor(() => expect(wakeSends).toBe(1));
    // 只投一次：之后再有 run 退场不重复唤醒
    const other = registry.startAuxiliary({ runId: 'aux-other', sessionId: SESSION, workspace: '/tmp/wake-project' });
    registry.unregister('aux-other', other);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wakeSends).toBe(1);
  });

  it('also delivers a busy-deferred wake on the TaskManager idle state_change', async () => {
    const task = await startForegroundWithTask();
    manager.state = { status: 'running' };
    settle(task);
    await vi.waitFor(() => expect(info.mock.calls.map((c) => String(c[0]))).toContain('Foreground wake deferred: session busy'));
    manager.state = { status: 'idle' };
    manager.emit('state_change', { type: 'state_change', sessionId: SESSION, data: { status: 'idle' } });
    await vi.waitFor(() => expect(wakeSends).toBe(1));
  });

  it('defers behind queued user input with a distinct reason, then wakes after it drains', async () => {
    const task = await startForegroundWithTask();
    queued = true;
    settle(task);
    await vi.waitFor(() => expect(info.mock.calls.map((c) => String(c[0]))).toContain('Foreground wake deferred: queued user input'));
    expect(wakeSends).toBe(0);
    // 队列没清空时 idle 不唤醒
    manager.emit('state_change', { type: 'state_change', sessionId: SESSION, data: { status: 'idle' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wakeSends).toBe(0);
    queued = false;
    manager.emit('state_change', { type: 'state_change', sessionId: SESSION, data: { status: 'idle' } });
    await vi.waitFor(() => expect(wakeSends).toBe(1));
  });

  it('routes wake terminal errors (both RUN_FAILED and thrown) to terminalErrorSink so TaskManager.observeAgentEvents sees only the backgroundWakeFailed system message while non-wake runs still deliver error events', async () => {
    const prevEvalDisabled = process.env.EVAL_DISABLED;
    process.env.EVAL_DISABLED = 'true';
    const realManager = initTaskManager();
    const observed: Array<{ sessionId: string; event: AgentEvent; taskId?: string }> = [];
    const broadcast: Array<{ sessionId: string; event: AgentEvent }> = [];
    const persistedNotes: Message[] = [];
    const configService = {
      getSettings: () => ({
        permissions: {
          autoApprove: { read: true, write: false, execute: false, network: false },
          devModeAutoApprove: false,
        },
        models: { default: 'openai', providers: {}, routing: {} },
      }),
      getApiKey: () => '',
      getServiceApiKey: () => '',
      isDevModeAutoApproveEnabled: () => false,
    } as unknown as ConfigService;
    realManager.initialize({
      configService,
      runRegistry: registry,
      onAgentEvent: (sessionId, event) => { broadcast.push({ sessionId, event }); },
    });
    const unobserve = realManager.observeAgentEvents((sessionId, event, taskId) => {
      observed.push({ sessionId, event, taskId });
    });
    const realOrchestrator = realManager.getOrCreateCurrentOrchestrator(SESSION);
    if (!realOrchestrator) throw new Error('expected real orchestrator');
    realOrchestrator.setWorkingDirectory('/tmp/wake-project', { syncWorkspaceServices: false });

    let loopBehavior: 'run_failed' | 'throw' = 'run_failed';
    const runNormalSpy = vi
      .spyOn(
        AgentOrchestrator.prototype as unknown as {
          runNormalMode: (
            content: string,
            onEvent: (event: AgentEvent) => void,
            modelConfig: { provider: string; model: string },
            sessionId?: string,
            options?: AgentRunOptions,
          ) => Promise<void>;
        },
        'runNormalMode',
      )
      .mockImplementation(async (_content, onEvent, modelConfig) => {
        onEvent({ type: 'error', data: { message: 'non-terminal warning', terminal: false } });
        if (loopBehavior === 'run_failed') {
          onEvent({
            type: 'error',
            data: {
              message: '401 invalid api key',
              code: 'RUN_FAILED',
              details: { provider: modelConfig.provider, model: modelConfig.model },
            },
          });
          return;
        }
        onEvent({
          type: 'error',
          data: {
            message: 'network connection reset',
            details: { provider: modelConfig.provider, model: modelConfig.model },
          },
        });
        throw new Error('network connection reset');
      });

    try {
      const realWake = createForegroundWake({
        getTaskManager: () => ({
          ...manager,
          getSessionState: () => manager.getSessionState(),
          getWaitingQueue: () => [],
          hasActivePrimaryRun: (sessionId: string) => manager.hasActivePrimaryRun(sessionId),
          onRunIdle: (listener: () => void) => manager.onRunIdle(listener),
          getOrCreateCurrentOrchestrator: () => realOrchestrator,
          setSessionContext: manager.setSessionContext,
          setWorkingDirectory: manager.setWorkingDirectory,
          on: manager.on.bind(manager),
        }),
        loadSession: async () => session,
        hasQueuedUserInput: () => false,
        isVoiceSession: () => false,
        recordWakeFailureNote: async (sessionId, content, detail) => {
          const message: Message = {
            id: `wake-note-${persistedNotes.length + 1}`,
            role: 'system',
            content,
            timestamp: Date.now(),
            metadata: { backgroundWakeFailed: detail },
          };
          persistedNotes.push(message);
          realManager.emitAgentEventForSession(sessionId, { type: 'message', data: message });
        },
        recordWakeDeferredNote: async () => undefined,
        setTimeout: () => 1,
        clearTimeout: () => undefined,
        logger: { info, warn },
      });

      const wakeTask: SessionCommandTask = {
        id: 'task-real-1',
        sessionId: SESSION,
        title: '任务一',
        shortName: '任务一',
        laneKey: 'lane-1',
        submissionKey: 'sub-1',
        prompt: '做点事',
        workspaceScope: SCOPE,
        status: 'completed',
        attempt: 1,
        createdAt: 1,
        updatedAt: 2,
        summary: '任务一完成',
      };

      // (a) RUN_FAILED resolving wake turn: note recorded once, terminal error suppressed, warning still delivered
      loopBehavior = 'run_failed';
      await realWake(wakeTask, 'completed');
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(persistedNotes).toHaveLength(1);
      expect(persistedNotes[0].metadata?.backgroundWakeFailed).toEqual({
        taskId: 'task-real-1',
        reason: 'turn_error',
      });
      expect(warn).toHaveBeenCalledWith(
        'Foreground wake failed: wake turn failed',
        expect.objectContaining({ sessionId: SESSION, taskId: 'task-real-1', message: '401 invalid api key' }),
      );
      expect(
        observed.filter((o) => o.event.type === 'error' && isTerminalAgentError(o.event.data)),
      ).toEqual([]);
      expect(
        broadcast.filter((b) => b.event.type === 'error' && isTerminalAgentError(b.event.data)),
      ).toEqual([]);
      expect(
        observed.filter((o) => o.event.type === 'error' && !isTerminalAgentError(o.event.data)),
      ).toHaveLength(1);
      expect(
        observed.filter(
          (o) => o.event.type === 'message' && Boolean((o.event.data as Message).metadata?.backgroundWakeFailed),
        ),
      ).toHaveLength(1);

      // (b) Throwing wake turn (emits terminal error then throws): note recorded once (not twice), no terminal error broadcast
      observed.length = 0;
      broadcast.length = 0;
      warn.mockClear();
      loopBehavior = 'throw';
      await realWake({ ...wakeTask, id: 'task-real-2' }, 'completed');
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(persistedNotes).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'Foreground wake failed: wake turn failed',
        expect.objectContaining({ sessionId: SESSION, taskId: 'task-real-2', message: 'network connection reset' }),
      );
      expect(
        observed.filter((o) => o.event.type === 'error' && isTerminalAgentError(o.event.data)),
      ).toEqual([]);
      expect(
        observed.filter(
          (o) => o.event.type === 'message' && Boolean((o.event.data as Message).metadata?.backgroundWakeFailed),
        ),
      ).toHaveLength(1);

      // (c) Non-wake run (no terminalErrorSink) still delivers the terminal error event unchanged
      observed.length = 0;
      broadcast.length = 0;
      loopBehavior = 'run_failed';
      await realOrchestrator.sendMessage('普通用户消息', undefined, { mode: 'normal' });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const terminalObserved = observed.filter(
        (o) => o.event.type === 'error' && isTerminalAgentError(o.event.data),
      );
      expect(terminalObserved).toHaveLength(1);
      expect(terminalObserved[0].event.data).toMatchObject({
        code: 'RUN_FAILED',
        message: '401 invalid api key',
      });
    } finally {
      runNormalSpy.mockRestore();
      unobserve();
      await realOrchestrator.drainWorkspaceServices();
      resetTaskManager();
      if (prevEvalDisabled === undefined) delete process.env.EVAL_DISABLED;
      else process.env.EVAL_DISABLED = prevEvalDisabled;
    }
  });
});
