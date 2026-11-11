import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleBackgroundSubagentIdleWake } from '../../../src/host/agent/backgroundSubagentIdleWake';
import { getBackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { getApplicationRunRegistry, resetApplicationRunRegistryForTests } from '../../../src/host/app/applicationRunRegistry';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';
import type { SubagentCompletionRecord } from '../../../src/host/agent/subagentCompletionNotification';

const taskManagerMocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  startTask: vi.fn(),
  observeAgentEvents: vi.fn(),
}));
const wakeNoteMocks = vi.hoisted(() => ({
  format: vi.fn((shortName: string) => `wake failed: ${shortName}`),
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

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => loggerMocks,
}));

vi.mock('../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => taskManagerMocks,
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
  beforeEach(() => {
    vi.useFakeTimers();
    resetApplicationRunRegistryForTests();
    taskManagerMocks.getSessionState.mockReset();
    taskManagerMocks.startTask.mockReset();
    loggerMocks.info.mockReset();
    taskManagerMocks.observeAgentEvents.mockReset();
    taskManagerMocks.observeAgentEvents.mockReturnValue(vi.fn());
    wakeNoteMocks.format.mockClear();
    wakeNoteMocks.record.mockReset();
    wakeNoteMocks.record.mockResolvedValue(undefined);
  });

  afterEach(() => {
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

    expect(wakeNoteMocks.format).toHaveBeenCalledWith('后台任务');
    expect(wakeNoteMocks.record).toHaveBeenCalledWith(
      'failed-session',
      'wake failed: 后台任务',
      { taskId: 'agent-failed', reason: 'owner_missing' },
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

    expect(wakeNoteMocks.record).toHaveBeenCalledWith('silent-session', expect.any(String), { taskId: 'agent-silent', reason: 'wake_failed' });
  });

  it.each([
    ['  百度页面摘要  \n使用 browser_action / Playwright；失败后改用 WebFetch。', '百度页面摘要'],
    ['打开百度首页并浏览其中两个页面然后整理成可直接阅读的简短中文摘要\n用 WebFetch 抓取。', '打开百度首页并浏览其中两个页面然后整理成可直接阅…'],
  ])('uses a short first-line name in a failed wake note: %s', async (title, shortName) => {
    taskManagerMocks.getSessionState.mockReturnValue({ status: 'idle' });
    taskManagerMocks.startTask.mockRejectedValue(new Error('model unavailable'));
    await seedCompletion('agent-long-title', 'short-name-session', title);
    scheduleBackgroundSubagentIdleWake(trigger('agent-long-title', 'short-name-session'));
    await vi.advanceTimersByTimeAsync(50);

    expect(wakeNoteMocks.format).toHaveBeenCalledWith(shortName);
    expect(wakeNoteMocks.record).toHaveBeenCalledWith(
      'short-name-session',
      `wake failed: ${shortName}`,
      { taskId: 'agent-long-title', reason: 'wake_failed' },
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
      { taskId: 'agent-throws', reason: 'wake_failed' },
    );
  });
});
