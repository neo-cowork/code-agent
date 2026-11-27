import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 预热失败句补写模块：recordFailure 里是动态 import，冷加载多一跳宏任务，
// 会让首条触发它的用例在 advanceTimersByTimeAsync 之后立刻断言时扑空。
import '../../../src/host/services/commandCenter/backgroundWakeNoteRetry';
import { buildStepCapConclusion } from '../../../src/host/agent/subagentStepCapConclusion';
import { scheduleBackgroundSubagentIdleWake } from '../../../src/host/agent/backgroundSubagentIdleWake';
import { getBackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { getApplicationRunRegistry, resetApplicationRunRegistryForTests } from '../../../src/host/app/applicationRunRegistry';
import { TaskManager } from '../../../src/host/task/TaskManager';
import { RunSessionConflictError } from '../../../src/host/runtime/runRegistry';
import type { AgentEvent } from '../../../src/shared/contract';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';
import type { SubagentCompletionRecord } from '../../../src/host/agent/subagentCompletionNotification';

const taskManagerMocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  startTask: vi.fn(),
  observeAgentEvents: vi.fn(),
}));
const orchestration = vi.hoisted(() => ({
  send: vi.fn<(sessionId: string, onEvent: (event: AgentEvent) => Promise<void>, content: string) => Promise<void>>(),
}));
vi.mock('../../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {
    private sessionId = '';
    constructor(private readonly config: { onEvent: (event: AgentEvent) => Promise<void> }) {}
    setSessionId(sessionId: string) { this.sessionId = sessionId; }
    sendMessage(content: string) { return orchestration.send(this.sessionId, this.config.onEvent, content); }
  },
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));
vi.mock('../../../src/host/task/taskManagerEventPersistence', () => ({
  persistTaskManagerEvent: vi.fn(),
}));

const recordStopNote = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/commandCenter/backgroundTaskStopNote', () => ({
  recordBackgroundTaskStopNote: recordStopNote,
}));

const wakeNoteMocks = vi.hoisted(() => ({
  format: vi.fn((shortName: string, _reason: string) => `wake failed: ${shortName}`),
  record: vi.fn(),
}));

vi.mock('../../../src/host/services/commandCenter/foregroundWake', () => ({
  formatBackgroundWakeFailureNote: wakeNoteMocks.format,
  recordBackgroundWakeFailureNote: wakeNoteMocks.record,
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const authHarness = vi.hoisted(() => ({
  user: null as { id: string } | null,
  callbacks: [] as Array<(user: { id: string } | null, status: string) => void>,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: loggerMocks,
  createLogger: () => loggerMocks,
}));

let realTaskManager: TaskManager | undefined;
vi.mock('../../../src/host/task/TaskManager', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/task/TaskManager')>(),
  getTaskManager: () => realTaskManager ?? taskManagerMocks,
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({
    getCurrentUser: () => authHarness.user,
    addAuthChangeCallback: (callback: (user: { id: string } | null, status: string) => void) => {
      authHarness.callbacks.push(callback);
      return () => {
        const index = authHarness.callbacks.indexOf(callback);
        if (index > -1) authHarness.callbacks.splice(index, 1);
      };
    },
  }),
}));

function subagentResult(output: string): SubagentResult {
  return { success: true, output } as SubagentResult;
}

/** 往真单例 registry 播种一条已完成的后台任务（生产路径同款：完成记录只能经 drain 消费）。 */
async function seedCompletion(agentId: string, sessionId: string, title?: string): Promise<void> {
  getBackgroundSubagentRegistry().spawn(async () => subagentResult(`${agentId} done`), {
    agentId,
    sessionId,
    role: 'coder',
    title,
    suppressIdleWake: true, // 播种阶段不触发 wake，由测试显式 schedule
  });
  await vi.advanceTimersByTimeAsync(0);
}

function trigger(agentId: string, sessionId: string): SubagentCompletionRecord {
  return {
    agentId,
    sessionId,
    role: 'coder',
    status: 'completed',
    summary: 'done',
    content: 'ignored',
    createdAt: 1,
    dedupeKey: `${sessionId}:${agentId}`,
  } as SubagentCompletionRecord;
}

describe('background subagent idle wake', () => {
  let caseClock = Date.UTC(2026, 0, 1);

  beforeEach(() => {
    // The singleton retains completion dedupe keys, so cases need distinct completion times.
    vi.useFakeTimers({ now: caseClock });
    caseClock += 1_000;
    resetApplicationRunRegistryForTests();
    taskManagerMocks.getSessionState.mockReset();
    taskManagerMocks.startTask.mockReset();
    loggerMocks.info.mockReset();
    taskManagerMocks.observeAgentEvents.mockReset();
    taskManagerMocks.observeAgentEvents.mockReturnValue(vi.fn());
    authHarness.user = null;
    authHarness.callbacks.length = 0;
    loggerMocks.warn.mockReset();
    wakeNoteMocks.format.mockClear();
    wakeNoteMocks.record.mockReset();
    wakeNoteMocks.record.mockResolvedValue(undefined);
  });

  afterEach(() => {
    realTaskManager = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetApplicationRunRegistryForTests();
  });

  it('batches simultaneous idle completions into one invisible parent turn', async () => {
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockResolvedValue(undefined);

    await seedCompletion('agent-a', 'idle-session');
    await seedCompletion('agent-b', 'idle-session');

    scheduleBackgroundSubagentIdleWake(trigger('agent-a', 'idle-session'));
    scheduleBackgroundSubagentIdleWake(trigger('agent-b', 'idle-session'));
    await vi.advanceTimersByTimeAsync(50);

    expect(taskManagerMocks.startTask).toHaveBeenCalledTimes(1);
    expect(taskManagerMocks.startTask).toHaveBeenCalledWith(
      'idle-session',
      expect.stringContaining('2 background tasks completed'),
      undefined,
      expect.objectContaining({
        mode: 'normal',
        inputHistoryVisibility: 'meta',
        maxIterations: 1,
        disableAutoAgent: true,
      }),
      expect.objectContaining({
        automation: expect.objectContaining({
          automationType: 'role_wake',
          sourceSessionId: 'idle-session',
        }),
      }),
      expect.stringContaining('background-subagent:idle-session:'),
    );

    // 只隐藏通知输入；整轮 meta 会把最后的助手汇报一起隐藏。
    expect(taskManagerMocks.startTask.mock.calls[0]?.[3]).not.toHaveProperty('historyVisibility');

    // 唤醒即消费：队列里不能再有这个 session 的记录（防止下一个工具结果双投递）
    expect(getBackgroundSubagentRegistry().drainCompletionNotifications({ sessionId: 'idle-session' })).toEqual([]);
  });

  it('does not wake running or paused parent sessions, and keeps records for the tool-result path', async () => {
    taskManagerMocks.getSessionState.mockReturnValueOnce({ status: 'running' });
    await seedCompletion('agent-running', 'busy-session');
    scheduleBackgroundSubagentIdleWake(trigger('agent-running', 'busy-session'));
    await vi.advanceTimersByTimeAsync(50);

    taskManagerMocks.getSessionState.mockReturnValueOnce({ status: 'paused' });
    await seedCompletion('agent-paused', 'paused-session');
    scheduleBackgroundSubagentIdleWake(trigger('agent-paused', 'paused-session'));
    await vi.advanceTimersByTimeAsync(50);

    expect(taskManagerMocks.startTask).not.toHaveBeenCalled();

    // 不消费：记录必须留给工具结果提醒路径投递
    const busy = getBackgroundSubagentRegistry().drainCompletionNotifications({ sessionId: 'busy-session' });
    expect(busy).toHaveLength(1);
    expect(busy[0]?.agentId).toBe('agent-running');
  });

  it('does not wake while the real run registry still owns the parent session', async () => {
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockResolvedValue(undefined);
    const registry = getApplicationRunRegistry();
    const primary = registry.start({
      runId: 'primary-run',
      sessionId: 'busy-session',
      workspace: process.cwd(),
    });

    await seedCompletion('agent-busy', 'busy-session');
    scheduleBackgroundSubagentIdleWake(trigger('agent-busy', 'busy-session'));
    await vi.advanceTimersByTimeAsync(50);

    expect(registry.hasSession('busy-session')).toBe(true);
    expect(taskManagerMocks.startTask).not.toHaveBeenCalled();
    expect(loggerMocks.info).toHaveBeenCalledWith(
      'skipped: parent run still registered',
      { sessionId: 'busy-session' },
    );
    expect(getBackgroundSubagentRegistry().drainCompletionNotifications({ sessionId: 'busy-session' })).toHaveLength(1);

    registry.unregister(primary.context.runId, primary);
    await vi.advanceTimersByTimeAsync(50);
    expect(taskManagerMocks.startTask).not.toHaveBeenCalled();
  });

  it('re-schedules one wake after the registered parent run becomes idle', async () => {
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockResolvedValue(undefined);
    const registry = getApplicationRunRegistry();
    const primary = registry.start({
      runId: 'primary-run-requeue',
      sessionId: 'busy-session-requeue',
      workspace: process.cwd(),
    });

    await seedCompletion('agent-busy-requeue', 'busy-session-requeue');
    scheduleBackgroundSubagentIdleWake(trigger('agent-busy-requeue', 'busy-session-requeue'));
    await vi.advanceTimersByTimeAsync(50);
    expect(taskManagerMocks.startTask).not.toHaveBeenCalled();

    registry.unregister(primary.context.runId, primary);
    await vi.advanceTimersByTimeAsync(50);

    expect(taskManagerMocks.startTask).toHaveBeenCalledTimes(1);
    expect(taskManagerMocks.startTask).toHaveBeenCalledWith(
      'busy-session-requeue',
      expect.stringContaining('1 background task completed'),
      undefined,
      expect.objectContaining({ mode: 'normal', inputHistoryVisibility: 'meta', maxIterations: 1 }),
      expect.anything(),
      expect.stringContaining('background-subagent:busy-session-requeue:'),
    );
  });

  it.each(['before pre-check', 'after drain'] as const)(
    'delivers the completion once after a web-direct parent registers %s',
    async (timing) => {
      const sessionId = `real-wake-${timing}`;
      const agentId = 'completed-helper';
      const sessionRegistry = getApplicationRunRegistry();
      const completions = getBackgroundSubagentRegistry();
      const emitted = vi.fn();
      const manager = new TaskManager();
      manager.initialize({ configService: {} as never, runRegistry: sessionRegistry, onAgentEvent: emitted });
      realTaskManager = manager;
      const started = vi.fn();
      manager.on('task_started', started);
      orchestration.send.mockReset();
      orchestration.send.mockImplementation(async (sid, onEvent, content) => {
        const run = sessionRegistry.start({ sessionId: sid, runId: 'wake-run', workspace: process.cwd() });
        try {
          await onEvent({
            type: 'message',
            data: { id: 'report', role: 'assistant', content, timestamp: Date.now() },
          });
        } finally {
          sessionRegistry.unregister(run.context.runId, run);
        }
      });

      const registerParent = () => sessionRegistry.start({
        sessionId, runId: 'web-direct-parent', workspace: process.cwd(),
      });
      await seedCompletion(agentId, sessionId);
      let parent = timing === 'before pre-check' ? registerParent() : undefined;
      if (!parent) {
        const drain = completions.drainCompletionNotifications.bind(completions);
        vi.spyOn(completions, 'drainCompletionNotifications').mockImplementationOnce((scope) => {
          const records = drain(scope);
          parent = registerParent();
          return records;
        });
      }
      expect(manager.getSessionState(sessionId).status).toBe('idle');

      scheduleBackgroundSubagentIdleWake(trigger(agentId, sessionId));
      await vi.advanceTimersByTimeAsync(50);
      try {
        expect(parent).toBeDefined();
        expect(started).not.toHaveBeenCalled();
        expect(manager.getSessionState(sessionId).status).toBe('idle');
        expect(emitted).not.toHaveBeenCalled();
        expect(wakeNoteMocks.record).not.toHaveBeenCalled();
        if (timing === 'before pre-check') {
          await expect(manager.startTask(sessionId, 'Another starter')).rejects.toMatchObject({
            code: 'RUN_SESSION_CONFLICT', existingRunId: 'web-direct-parent',
          });
        }
      } finally {
        if (parent) sessionRegistry.unregister(parent.context.runId, parent);
        await vi.advanceTimersByTimeAsync(50);
      }

      expect(started).toHaveBeenCalledTimes(1);
      expect(orchestration.send).toHaveBeenCalledExactlyOnceWith(
        sessionId, expect.any(Function), expect.stringContaining(`${agentId} done`),
      );
      expect(emitted).toHaveBeenCalledExactlyOnceWith(sessionId, expect.objectContaining({ type: 'message' }));
      expect(wakeNoteMocks.record).not.toHaveBeenCalled();
      expect(completions.drainCompletionNotifications({ sessionId })).toEqual([]);
    },
  );

  it('records the existing user-visible note when the notification turn emits an error', async () => {
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockImplementation(async () => {
      const observer = taskManagerMocks.observeAgentEvents.mock.calls[0]?.[0];
      if (!observer) throw new Error('Expected the wake error observer');
      observer('failed-session', {
        type: 'error',
        data: { message: 'Durable Run run-parent has no live owner lease' },
      });
    });
    await seedCompletion('agent-failed', 'failed-session');
    scheduleBackgroundSubagentIdleWake(trigger('agent-failed', 'failed-session'));
    await vi.advanceTimersByTimeAsync(50);

    expect(wakeNoteMocks.format).toHaveBeenCalledWith('后台任务', 'owner_missing');
    expect(wakeNoteMocks.record).toHaveBeenCalledWith(
      'failed-session',
      'wake failed: 后台任务',
      { taskId: 'agent-failed', reason: 'owner_missing', title: '后台任务' },
    );
  });


  it('truncates a long task title at a word boundary in the wake failure note', async () => {
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockImplementation(async () => {
      const observer = taskManagerMocks.observeAgentEvents.mock.calls[0]?.[0];
      if (!observer) throw new Error('Expected the wake error observer');
      observer('long-title-session', { type: 'error', data: { message: 'wake blew up' } });
    });
    // 旧实现 slice(0, 24) 会得到「Compare Tauri and Electr…」半词（FB-1933 同款病形）。
    await seedCompletion('agent-long-title', 'long-title-session', 'Compare Tauri and Electron startup time');
    scheduleBackgroundSubagentIdleWake(trigger('agent-long-title', 'long-title-session'));
    await vi.advanceTimersByTimeAsync(50);

    expect(wakeNoteMocks.format).toHaveBeenCalledWith('Compare Tauri and…', 'wake_failed');
    expect(wakeNoteMocks.record).toHaveBeenCalledWith(
      'long-title-session',
      'wake failed: Compare Tauri and…',
      { taskId: 'agent-long-title', reason: 'wake_failed', title: 'Compare Tauri and…' },
    );
  });

  it('does not record a failure note when the wake turn already reported and only hit its one-step budget', async () => {
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockImplementation(async () => {
      const observer = taskManagerMocks.observeAgentEvents.mock.calls[0]?.[0];
      if (!observer) throw new Error('Expected the wake observer');
      observer('reported-session', { type: 'message', data: { id: 'm1', role: 'assistant', content: '百度热搜摘要', timestamp: 1 } });
      observer('reported-session', { type: 'error', data: { message: 'Max iterations reached' } });
    });
    await seedCompletion('agent-reported', 'reported-session');
    scheduleBackgroundSubagentIdleWake(trigger('agent-reported', 'reported-session'));
    await vi.advanceTimersByTimeAsync(50);

    expect(wakeNoteMocks.record).not.toHaveBeenCalled();
  });

  it('still records the note when the one-step budget ends without any report text', async () => {
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockImplementation(async () => {
      const observer = taskManagerMocks.observeAgentEvents.mock.calls[0]?.[0];
      if (!observer) throw new Error('Expected the wake observer');
      observer('silent-session', { type: 'error', data: { message: 'Max iterations reached' } });
    });
    await seedCompletion('agent-silent', 'silent-session');
    scheduleBackgroundSubagentIdleWake(trigger('agent-silent', 'silent-session'));
    await vi.advanceTimersByTimeAsync(50);

    expect(wakeNoteMocks.record).toHaveBeenCalledWith('silent-session', expect.any(String), { taskId: 'agent-silent', reason: 'max_iterations', title: '后台任务' });
  });

  it('uses one generic stop note when a file-reading child reaches its step cap', async () => {
    const agentId = 'child-with-stop-note';
    const sessionId = 'session-with-stop-note';
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    recordStopNote.mockClear();
    const registry = getBackgroundSubagentRegistry();
    registry.adopt(Promise.resolve({
      success: false, output: '', error: 'Max iterations reached', toolsUsed: ['Read'], iterations: 1,
      stopHint: {
        kind: 'step_cap',
        conclusion: buildStepCapConclusion({
          iterations: 1, maxIterations: 1,
          messages: [{ role: 'assistant', toolCalls: [{ arguments: { path: 'release.txt' } }] }],
        }),
      },
    }), {
      agentId, sessionId, completionKind: 'user_visible', onComplete: scheduleBackgroundSubagentIdleWake,
    });
    await registry.await(agentId);
    await vi.advanceTimersByTimeAsync(50);

    expect(recordStopNote).toHaveBeenCalledExactlyOnceWith(
      sessionId, expect.any(String), expect.stringContaining('还没有得出最终结果'), { taskId: agentId, kind: 'step_cap' },
    );
    expect(recordStopNote.mock.calls[0]?.[2]).not.toContain('网站');
    expect(recordStopNote.mock.calls[0]?.[2]).toContain('或者把任务缩小一些再试一次');
    expect(taskManagerMocks.startTask).not.toHaveBeenCalled();
    expect(registry.drainCompletionNotifications({ sessionId })).toEqual([]);
  });

  it('passes a failed child’s partial answer to the idle report without a second note', async () => {
    const agentId = 'child-with-partial-answer';
    const sessionId = 'session-with-partial-answer';
    const output = 'The rollback plan is in release.txt. The recovery check is still unconfirmed.';
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockImplementation(async () => {
      const observer = taskManagerMocks.observeAgentEvents.mock.calls[0]?.[0];
      observer(sessionId, { type: 'message', data: { role: 'assistant', content: output } });
    });
    recordStopNote.mockClear();
    const registry = getBackgroundSubagentRegistry();
    registry.adopt(Promise.resolve({
      success: false, output, error: 'Max iterations reached', toolsUsed: [], iterations: 1,
    }), {
      agentId, sessionId, completionKind: 'user_visible', onComplete: scheduleBackgroundSubagentIdleWake,
    });
    await registry.await(agentId);
    await vi.advanceTimersByTimeAsync(50);

    expect(taskManagerMocks.startTask).toHaveBeenCalledExactlyOnceWith(
      sessionId, expect.stringContaining(output), undefined,
      expect.objectContaining({ completionReportOnly: true }), expect.anything(), expect.any(String),
    );
    expect(recordStopNote).not.toHaveBeenCalled();
    expect(wakeNoteMocks.record).not.toHaveBeenCalled();
    expect(registry.drainCompletionNotifications({ sessionId })).toEqual([]);
  });

  it.each([
    { content: '   ', toolCalls: [] },
    { content: 'Checking the result', toolCalls: [{ name: 'Read' }] },
  ])('records a visible failure when a wake returns without a report (%j)', async (message) => {
    const sessionId = 'wake-without-report';
    const agentId = 'child-without-report';
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockImplementation(async () => {
      const observer = taskManagerMocks.observeAgentEvents.mock.calls[0]?.[0];
      observer(sessionId, { type: 'message', data: { role: 'assistant', ...message } });
    });
    await seedCompletion(agentId, sessionId);
    scheduleBackgroundSubagentIdleWake(trigger(agentId, sessionId));
    await vi.advanceTimersByTimeAsync(50);

    expect(wakeNoteMocks.record).toHaveBeenCalledExactlyOnceWith(
      sessionId, 'wake failed: 后台任务', { taskId: agentId, reason: 'wake_failed', title: '后台任务' },
    );
  });

  it.each([
    ['  百度页面摘要  \n使用 browser_action / Playwright；失败后改用 WebFetch。', '百度页面摘要'],
    ['打开百度首页并浏览其中两个页面然后整理成可直接阅读的简短中文摘要\n用 WebFetch 抓取。', '打开百度首页并浏览其中两个页面然后整理成可直接…'],
  ])('uses a short first-line name in a failed wake note: %s', async (title, shortName) => {
    // The process-wide completion registry retains consumed dedupe keys between cases.
    const agentId = `agent-long-title-${title.length}`;
    const sessionId = `short-name-session-${title.length}`;
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockRejectedValue(new Error('model unavailable'));
    await seedCompletion(agentId, sessionId, title);
    scheduleBackgroundSubagentIdleWake(trigger(agentId, sessionId));
    await vi.advanceTimersByTimeAsync(50);

    expect(wakeNoteMocks.format).toHaveBeenCalledWith(shortName, 'wake_failed');
    expect(wakeNoteMocks.record).toHaveBeenCalledWith(
      sessionId,
      `wake failed: ${shortName}`,
      { taskId: agentId, reason: 'wake_failed', title: shortName },
    );
    expect(wakeNoteMocks.format.mock.calls[0]?.[0]).not.toMatch(/browser_action|Playwright|WebFetch|\n/);
  });

  it('records the note when starting the notification turn throws directly', async () => {
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockRejectedValue(new Error('model unavailable'));
    await seedCompletion('agent-throws', 'throwing-session');
    scheduleBackgroundSubagentIdleWake(trigger('agent-throws', 'throwing-session'));
    await vi.advanceTimersByTimeAsync(50);

    expect(wakeNoteMocks.record).toHaveBeenCalledWith(
      'throwing-session',
      'wake failed: 后台任务',
      { taskId: 'agent-throws', reason: 'wake_failed', title: '后台任务' },
    );
  });

  it('retries a run-session conflict without a failure note when the parent already exited', async () => {
    const sessionId = 'conflict-parent-exited';
    const registry = getApplicationRunRegistry();
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockImplementationOnce(async () => {
      const parent = registry.start({ sessionId, runId: 'brief-parent', workspace: process.cwd() });
      registry.unregister(parent.context.runId, parent);
      throw new RunSessionConflictError(sessionId, parent.context.runId);
    });
    taskManagerMocks.startTask.mockImplementationOnce(async () => {
      const observer = taskManagerMocks.observeAgentEvents.mock.calls.at(-1)?.[0];
      observer(sessionId, { type: 'message', data: { role: 'assistant', content: 'Helper finished' } });
    });
    await seedCompletion('agent-conflict', sessionId);
    scheduleBackgroundSubagentIdleWake(trigger('agent-conflict', sessionId));
    await vi.advanceTimersByTimeAsync(100);

    expect(taskManagerMocks.startTask).toHaveBeenCalledTimes(2);
    expect(taskManagerMocks.startTask).toHaveBeenLastCalledWith(
      sessionId, expect.stringContaining('agent-conflict done'), undefined,
      expect.anything(), expect.anything(), expect.any(String),
    );
    expect(wakeNoteMocks.record).not.toHaveBeenCalled();
  });

  it('retries the failure note after the owner is restored when the first write hits an inaccessible session', async () => {
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    authHarness.user = null;
    wakeNoteMocks.record
      .mockRejectedValueOnce(new Error('Session restore-session not found'))
      .mockResolvedValue(undefined);
    taskManagerMocks.startTask.mockRejectedValue(new Error('model unavailable'));
    await seedCompletion('agent-restore', 'restore-session');
    scheduleBackgroundSubagentIdleWake(trigger('agent-restore', 'restore-session'));
    await vi.advanceTimersByTimeAsync(50);

    // 登录恢复窗口里失败句写不进：留有区别度的 warn，不静默
    expect(wakeNoteMocks.record).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'Background wake failure note not recorded',
      expect.objectContaining({
        reason: 'wake_failure_note_not_recorded',
        sessionId: 'restore-session',
        taskId: 'agent-restore',
      }),
    );

    // owner 恢复 → 补写一次，恰好一次
    authHarness.user = { id: 'u1' };
    for (const callback of [...authHarness.callbacks]) callback(authHarness.user, 'authenticated');
    await vi.advanceTimersByTimeAsync(0);
    expect(wakeNoteMocks.record).toHaveBeenCalledTimes(2);
    expect(wakeNoteMocks.record).toHaveBeenLastCalledWith(
      'restore-session',
      'wake failed: 后台任务',
      { taskId: 'agent-restore', reason: 'wake_failed', title: '后台任务' },
    );
  });
  it.each([
    ['text', new Error('Rate limit exceeded'), 'rate_limited'],
    ['429', Object.assign(new Error('Request rejected'), { status: 429 }), 'rate_limited'],
    ['owner', new Error('Session idle-owner not found'), 'owner_missing'],
  ] as const)('classifies %s failure through the idle wake entry and retry wrapper', async (kind, error, reason) => {
    const sessionId = `classified-${kind}`;
    const agentId = `agent-${kind}`;
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockRejectedValue(error);
    await seedCompletion(agentId, sessionId);
    scheduleBackgroundSubagentIdleWake(trigger(agentId, sessionId));
    await vi.advanceTimersByTimeAsync(50);
    expect(wakeNoteMocks.format).toHaveBeenCalledWith('后台任务', reason);
    expect(wakeNoteMocks.record).toHaveBeenCalledWith(sessionId, 'wake failed: 后台任务', { taskId: agentId, reason, title: '后台任务' });
    expect(loggerMocks.warn.mock.calls.some(([message]) => message.includes('wake failure note not recorded'))).toBe(false);
  });

  it.each(['event', 'sink'])('keeps a structured 429 from the idle wake %s', async (source) => {
    const sessionId = `structured-${source}`;
    const agentId = `agent-${source}`;
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockImplementation(async (...args: unknown[]) => {
      const payload = { statusCode: 429, message: 'Request rejected' };
      if (source === 'event') taskManagerMocks.observeAgentEvents.mock.calls[0][0](sessionId, { type: 'error', data: payload });
      else (args[3] as { terminalErrorSink(data: unknown): void }).terminalErrorSink(payload);
    });
    await seedCompletion(agentId, sessionId);
    scheduleBackgroundSubagentIdleWake(trigger(agentId, sessionId));
    await vi.advanceTimersByTimeAsync(50);
    expect(wakeNoteMocks.record).toHaveBeenCalledWith(sessionId, expect.any(String), { taskId: agentId, reason: 'rate_limited', title: '后台任务' });
  });

});
