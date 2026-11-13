import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, ToolContext } from '../../../../src/host/protocol/tools';
import type { TaskManagerEvent } from '../../../../src/host/task/TaskManager';
import type { AgentEvent } from '../../../../src/shared/contract';
import {
  getSessionCommandCenter,
  resetSessionCommandCenterForTest,
} from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import {
  resetBackgroundTaskLedgerForTest,
} from '../../../../src/host/task/backgroundTaskLedger';
import { executeDelegateTask } from '../../../../src/host/tools/modules/commandCenter/sessionCommandCenter';
import { delegateTaskSchema } from '../../../../src/host/tools/modules/commandCenter/sessionCommandCenter.schema';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';

const persistMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({ getSessionManager: () => ({ addMessageToSession: persistMessage }) }));

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/host/tools/utils/userQuestionPrompt', () => ({
  promptUserInChat: promptMock,
}));

const singletonTaskManagerHolder = vi.hoisted(() => ({ manager: undefined as unknown }));
vi.mock('../../../../src/host/task/TaskManager', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTaskManager: () => singletonTaskManagerHolder.manager,
}));

class FakeTaskManager extends EventEmitter {
  private readonly sessionByTask = new Map<string, string>();
  startBackgroundTask = vi.fn().mockImplementation(async (taskId: string, sessionId: string) => {
    this.sessionByTask.set(taskId, sessionId);
  });
  interruptBackgroundTask = vi.fn().mockResolvedValue(true);
  cancelBackgroundTask = vi.fn().mockImplementation(async (taskId: string) => {
    const sessionId = this.sessionByTask.get(taskId) ?? 'session-replace';
    this.emit('task_cancelled', {
      type: 'task_cancelled',
      sessionId,
      data: { taskId },
    } satisfies TaskManagerEvent);
    return true;
  });

  observeAgentEvents(_observer: (sessionId: string, event: AgentEvent, taskId?: string) => void): () => void {
    return () => {};
  }
}

const WORKSPACE_SCOPE = createWorkspaceScope('project-overflow', [{
  sourceId: 'source-overflow',
  path: '/tmp/overflow-project',
  role: 'primary',
  access: 'read_write',
}]);

function toolContext(sessionId: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId,
    workingDir: WORKSPACE_SCOPE.primaryRoot,
    workspace: WORKSPACE_SCOPE.primaryRoot,
    workspaceScope: WORKSPACE_SCOPE,
    abortSignal: new AbortController().signal,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    emit: vi.fn(),
    ...overrides,
  };
}

function taskArgs(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: `后台任务 ${index}`,
    short_name: `任务${index}`,
    lane_key: `lane-${index}`,
    submission_key: `sub-${index}`,
    prompt: `执行第 ${index} 项任务`,
    ...overrides,
  };
}

const allow: CanUseToolFn = vi.fn().mockResolvedValue({ allow: true });

describe('delegate_task overflow choice in host', () => {
  let fakeManager: FakeTaskManager;

  beforeEach(() => {
    resetSessionCommandCenterForTest();
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
    fakeManager = new FakeTaskManager();
    singletonTaskManagerHolder.manager = fakeManager;
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetSessionCommandCenterForTest();
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
  });

  it('when this session hits its slot limit, shows Queue + replaceable tasks + Not now, creates nothing before choice, and queues on Queue answer', async () => {
    const session = 'session-local-full';
    await executeDelegateTask(taskArgs(1), toolContext(session), allow);
    await executeDelegateTask(taskArgs(2), toolContext(session), allow);
    expect(getSessionCommandCenter().list(session)).toHaveLength(2);

    let tasksBeforeUserChoice = -1;
    promptMock.mockImplementationOnce(async () => {
      tasksBeforeUserChoice = getSessionCommandCenter().list(session).length;
      return {
        status: 'answered',
        response: { requestId: 'req-queue', answers: { 任务已满: '排队' } },
      };
    });

    const third = await executeDelegateTask(taskArgs(3), toolContext(session), allow);

    expect(tasksBeforeUserChoice).toBe(2);
    expect(promptMock).toHaveBeenCalledOnce();
    const [questions] = promptMock.mock.calls[0];
    expect(questions).toHaveLength(1);
    expect(questions[0].header).toBe('任务已满');
    expect(questions[0].question).toContain('任务3');
    expect(questions[0].options.map((opt: { label: string }) => opt.label)).toEqual([
      '排队',
      '替换任务1',
      '替换任务2',
      '暂不创建',
    ]);
    expect(questions[0].options.length).toBeGreaterThanOrEqual(2);
    expect(questions[0].options.length).toBeLessThanOrEqual(4);

    expect(third.ok).toBe(true);
    assert(third.ok);
    expect(third.output).toContain('已把「任务3」');
    expect(third.output).not.toMatch(/session-work-|queued|accepted|requires_choice|lane_busy/);
    const allTasks = getSessionCommandCenter().list(session);
    expect(allTasks).toHaveLength(3);
    expect(allTasks[2]).toMatchObject({ shortName: '任务3', status: 'queued' });
  });

  it('when global pool is filled by other sessions and this session has empty active list, still offers >= 2 options (Queue and Not now)', async () => {
    await executeDelegateTask(taskArgs(1), toolContext('other-session-1'), allow);
    await executeDelegateTask(taskArgs(2), toolContext('other-session-1'), allow);
    await executeDelegateTask(taskArgs(3), toolContext('other-session-2'), allow);
    await executeDelegateTask(taskArgs(4), toolContext('other-session-2'), allow);

    const currentSession = 'session-empty-active';
    expect(getSessionCommandCenter().active(currentSession)).toEqual([]);

    promptMock.mockResolvedValueOnce({
      status: 'answered',
      response: { requestId: 'req-global-queue', answers: { 任务已满: '排队' } },
    });

    const result = await executeDelegateTask(taskArgs(5), toolContext(currentSession), allow);

    expect(promptMock).toHaveBeenCalledOnce();
    const [questions] = promptMock.mock.calls[0];
    expect(questions[0].header).toBe('任务已满');
    expect(questions[0].options.map((opt: { label: string }) => opt.label)).toEqual([
      '排队',
      '暂不创建',
    ]);
    expect(questions[0].options).toHaveLength(2);
    expect(result).toMatchObject({ ok: true });
    assert(result.ok);
    expect(result.output).toContain('已把「任务5」');
    expect(getSessionCommandCenter().list(currentSession)).toEqual([
      expect.objectContaining({ shortName: '任务5', status: 'queued' }),
    ]);
  });

  it('when user chooses to replace an active task, cancels that task via command center and starts the new task', async () => {
    const session = 'session-replace';
    await executeDelegateTask(taskArgs(1), toolContext(session), allow);
    await executeDelegateTask(taskArgs(2), toolContext(session), allow);

    promptMock.mockResolvedValueOnce({
      status: 'answered',
      response: { requestId: 'req-replace', answers: { 任务已满: '替换任务1' } },
    });

    const result = await executeDelegateTask(taskArgs(3), toolContext(session), allow);

    expect(fakeManager.cancelBackgroundTask).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    assert(result.ok);
    expect(result.output).toContain('已停止「任务1」');
    expect(result.output).toContain('后台任务「任务3」');
    expect(result.output).toContain('你刚才选择的替换');

    const tasks = getSessionCommandCenter().list(session);
    expect(tasks.find((t) => t.shortName === '任务1')?.status).toBe('cancelled');
    expect(tasks.find((t) => t.shortName === '任务3')?.status).toBe('running');
  });

  it('starts an explicitly selected replacement before an older queued task', async () => {
    const session = 'session-replace-with-queue';
    await executeDelegateTask(taskArgs(1), toolContext(session), allow);
    await executeDelegateTask(taskArgs(2), toolContext(session), allow);
    await executeDelegateTask(taskArgs(3, { queue_when_full: true }), toolContext(session), allow);
    promptMock.mockResolvedValueOnce({
      status: 'answered', response: { requestId: 'replace-with-queue', answers: { 任务已满: '替换任务1' } },
    });
    const result = await executeDelegateTask(taskArgs(4), toolContext(session), allow);
    assert(result.ok);
    expect(result.output.startsWith('已停止「任务1」')).toBe(true);
    const tasks = getSessionCommandCenter().list(session);
    expect(tasks.find((task) => task.shortName === '任务1')?.status).toBe('cancelled');
    expect(tasks.find((task) => task.shortName === '任务3')?.status).toBe('queued');
    expect(tasks.find((task) => task.shortName === '任务4')?.status).toBe('running');
  });

  it('reserves the next slot for a replacement when cancellation completes later', async () => {
    const session = 'session-delayed-replace-with-queue';
    await executeDelegateTask(taskArgs(1), toolContext(session), allow);
    await executeDelegateTask(taskArgs(2), toolContext(session), allow);
    await executeDelegateTask(taskArgs(3, { queue_when_full: true }), toolContext(session), allow);
    const original = getSessionCommandCenter().list(session).find((task) => task.shortName === '任务1');
    assert(original);
    fakeManager.cancelBackgroundTask.mockResolvedValueOnce(true);
    promptMock.mockResolvedValueOnce({
      status: 'answered', response: { requestId: 'delayed-replace', answers: { 任务已满: '替换任务1' } },
    });
    setTimeout(() => fakeManager.emit('task_cancelled', { type: 'task_cancelled', sessionId: session, data: { taskId: original.id } } satisfies TaskManagerEvent), 10);
    const result = await executeDelegateTask(taskArgs(4), toolContext(session), allow);
    assert(result.ok);
    expect(result.output).toContain('已停止「任务1」');
    await vi.waitFor(() => {
      const tasks = getSessionCommandCenter().list(session);
      expect(tasks.find((task) => task.shortName === '任务3')?.status).toBe('queued');
      expect(tasks.find((task) => task.shortName === '任务4')?.status).toBe('running');
    });
  });

  it('waits for delayed cancellation before reporting that replacement started', async () => {
    const session = 'session-confirm-replacement';
    await executeDelegateTask(taskArgs(1), toolContext(session), allow);
    await executeDelegateTask(taskArgs(2), toolContext(session), allow);
    await executeDelegateTask(taskArgs(3, { queue_when_full: true }), toolContext(session), allow);
    const original = getSessionCommandCenter().list(session).find((task) => task.shortName === '任务1');
    assert(original);
    fakeManager.cancelBackgroundTask.mockImplementationOnce(async () => {
      setTimeout(() => fakeManager.emit('task_cancelled', {
        type: 'task_cancelled', sessionId: session, data: { taskId: original.id },
      } satisfies TaskManagerEvent), 10);
      return true;
    });
    promptMock.mockResolvedValueOnce({
      status: 'answered', response: { requestId: 'confirm-replace', answers: { 任务已满: '替换任务1' } },
    });
    const result = await executeDelegateTask(taskArgs(4), toolContext(session), allow);
    assert(result.ok);
    expect(result.output.startsWith('已停止「任务1」')).toBe(true);
    expect(result.output).toContain('后台任务「任务4」');
    expect(getSessionCommandCenter().list(session).find((task) => task.shortName === '任务3')?.status).toBe('queued');
  });

  it.each(['missing', 'ambiguous', 'rejected'] as const)(
    'does not claim cancellation or create a replacement when cancel is %s', async (outcome) => {
      const session = 'session-cancel-failure';
      await executeDelegateTask(taskArgs(1), toolContext(session), allow);
      await executeDelegateTask(taskArgs(2), toolContext(session), allow);
      const center = getSessionCommandCenter();
      const cancel = vi.spyOn(center, 'cancel');
      if (outcome === 'rejected') fakeManager.cancelBackgroundTask.mockResolvedValueOnce(false);
      else if (outcome === 'ambiguous') cancel.mockResolvedValueOnce({ outcome, candidates: center.active(session) });
      else cancel.mockResolvedValueOnce({ outcome });
      promptMock.mockResolvedValueOnce({
        status: 'answered', response: { requestId: 'cancel-failure', answers: { 任务已满: '替换任务1' } },
      });
      const result = await executeDelegateTask(taskArgs(3), toolContext(session), allow);
      assert(result.ok);
      expect(result.output).not.toMatch(/已停止|已请求停止/);
      expect(result.output).toContain('尚未创建');
      expect(result.output).toContain('没有加入排队');
      expect(result.output).toContain('回复“排队”');
      expect(center.list(session)).toHaveLength(2);
      expect(result.meta).toBeUndefined();
      cancel.mockRestore();
    },
  );

  it.each([
    ['排队', false, 'queued', 'queued'],
    ['替换任务1', false, 'accepted', 'running'],
    ['替换任务1', true, 'queued', 'queued'],
  ] as const)('preserves localized receipt metadata for %s with delayed cancellation %s', async (answer, delayed, outcome, status) => {
    const session = 'session-receipt';
    await executeDelegateTask(taskArgs(1), toolContext(session), allow);
    await executeDelegateTask(taskArgs(2), toolContext(session), allow);
    if (delayed) fakeManager.cancelBackgroundTask.mockResolvedValueOnce(true);
    promptMock.mockResolvedValueOnce({
      status: 'answered', response: { requestId: 'receipt', answers: { 任务已满: answer } },
    });
    const result = await executeDelegateTask(taskArgs(3), toolContext(session), allow);
    assert(result.ok);
    expect(result.meta).toMatchObject({ sessionTask: { outcome, tasks: [{ shortName: '任务3', status }] } });
    if (answer.startsWith('替换')) expect(result.meta).toMatchObject({ sessionTaskReplacement: { shortName: '任务1', stopped: !delayed } });
    if (delayed) {
      expect(result.output).toContain('已请求停止「任务1」');
      expect(result.output).not.toContain('已停止「任务1」');
    }
  }, 20_000);

  it('when user chooses Not now (暂不创建), creates no task and does not queue', async () => {
    const session = 'session-not-now';
    await executeDelegateTask(taskArgs(1), toolContext(session), allow);
    await executeDelegateTask(taskArgs(2), toolContext(session), allow);

    promptMock.mockResolvedValueOnce({
      status: 'answered',
      response: { requestId: 'req-not-now', answers: { 任务已满: '暂不创建' } },
    });

    const result = await executeDelegateTask(taskArgs(3), toolContext(session), allow);

    expect(result.ok).toBe(true);
    assert(result.ok);
    expect(result.output).toContain('未创建');
    expect(result.output).toContain('未加入排队');
    expect(getSessionCommandCenter().list(session)).toHaveLength(2);
  });

  it.each([
    ['no-renderer', { status: 'no-renderer' as const }],
    ['aborted', { status: 'aborted' as const }],
    ['timeout', { status: 'timeout' as const, reason: '等待超时' }],
    ['declined', { status: 'declined' as const, response: { requestId: 'r-dec', declined: true, answers: {} } }],
  ])('returns plain fallback text and creates no task when prompt status is %s', async (_label, promptOutcome) => {
    const session = `session-fallback-${_label}`;
    await executeDelegateTask(taskArgs(1), toolContext(session), allow);
    await executeDelegateTask(taskArgs(2), toolContext(session), allow);

    promptMock.mockResolvedValueOnce(promptOutcome);

    const result = await executeDelegateTask(taskArgs(3), toolContext(session), allow);

    expect(result.ok).toBe(true);
    assert(result.ok);
    expect(result.output).toContain('尚未创建');
    expect(result.output).toContain('没有加入排队');
    expect(result.output).toContain('回复“排队”');
    expect(persistMessage).toHaveBeenCalledWith(session, expect.objectContaining({ role: 'assistant', content: result.output }));
    expect(result.output).not.toMatch(/no-renderer|aborted|timeout|declined|INVALID_ARGS/i);
    expect(getSessionCommandCenter().list(session)).toHaveLength(2);
  });

  it('starts the chosen queued task on release and persists its completed result', async () => {
    const session = 'queue-completion';
    await executeDelegateTask(taskArgs(1), toolContext(session), allow);
    await executeDelegateTask(taskArgs(2), toolContext(session), allow);
    promptMock.mockResolvedValueOnce({ status: 'answered', response: { requestId: 'queue', answers: { 任务已满: '排队' } } });
    await executeDelegateTask(taskArgs(3), toolContext(session), allow);
    const [first, , queued] = getSessionCommandCenter().list(session);
    expect(queued.status).toBe('queued');
    fakeManager.emit('task_completed', { type: 'task_completed', sessionId: session, data: { taskId: first.id, conclusion: '周报已写出' } });
    await vi.waitFor(() => expect(fakeManager.startBackgroundTask).toHaveBeenCalledTimes(3));
    expect(getSessionCommandCenter().list(session)[2].status).toBe('running');
    fakeManager.emit('task_completed', { type: 'task_completed', sessionId: session, data: { taskId: queued.id, conclusion: '三点简报已写出' } });
    await vi.waitFor(() => expect(persistMessage).toHaveBeenCalledWith(session, expect.objectContaining({
      content: expect.stringContaining('三点简报已写出'),
      metadata: expect.objectContaining({ backgroundTaskResult: expect.objectContaining({ taskId: queued.id, status: 'completed' }) }),
    })));
    expect(getSessionCommandCenter().list(session)[2].status).toBe('completed');
  });

  it('documents queue_when_full without telling the model to call AskUserQuestion on overflow', () => {
    const desc = delegateTaskSchema.inputSchema.properties?.queue_when_full?.description ?? '';
    expect(desc).toContain('排队');
    expect(desc).not.toContain('AskUserQuestion');
  });
});
