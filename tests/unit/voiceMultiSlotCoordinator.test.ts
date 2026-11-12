import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/shared/contract/agent';
import type { VoiceWorkItem, VoiceWorkNarration } from '../../src/shared/contract/voice';
import { SESSION_TASK_SLOT_TIMEOUT_MS } from '../../src/shared/constants/voice';
import {
  getVoiceTaskConcurrencyPool,
  resetVoiceTaskConcurrencyPoolForTest,
  VoiceTaskSlotLedger,
} from '../../src/host/services/voice/voiceTaskSlotLedger';

type TaskEvent = { type: string; sessionId: string; data?: unknown };

const runtime = vi.hoisted(() => ({
  perSessionLimit: 2,
  listeners: new Set<(event: TaskEvent) => void>(),
  observers: new Set<(sessionId: string, event: AgentEvent, taskId?: string) => void>(),
  startBackgroundTask: vi.fn<(
    taskId: string,
    sessionId: string,
    message: string,
    attachments?: unknown[],
    options?: unknown,
    metadata?: unknown,
  ) => Promise<void>>(async () => undefined),
  cancelBackgroundTask: vi.fn<(taskId: string) => Promise<boolean>>(async () => true),
  interruptBackgroundTask: vi.fn<(
    taskId: string,
    message: string,
    attachments?: unknown[],
    options?: unknown,
  ) => Promise<{ outcome: 'steered' }>>(async () => ({ outcome: 'steered' as const })),
  promptUserInChat: vi.fn<typeof import('../../src/host/tools/utils/userQuestionPrompt').promptUserInChat>(
    async () => ({ status: 'timeout' as const }),
  ),
  emit(type: string, taskId: string, data: Record<string, unknown> = {}) {
    for (const listener of this.listeners) {
      listener({ type, sessionId: 'session-1', data: { ...data, taskId } });
    }
  },
}));

vi.mock('../../src/shared/constants/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/constants/voice')>();
  return {
    ...actual,
    SESSION_TASK_CONCURRENCY: {
      ...actual.SESSION_TASK_CONCURRENCY,
      get perSession() { return runtime.perSessionLimit; },
    },
  };
});

vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    on: (_event: string, listener: (event: TaskEvent) => void) => runtime.listeners.add(listener),
    off: (_event: string, listener: (event: TaskEvent) => void) => runtime.listeners.delete(listener),
    observeAgentEvents: (observer: (sessionId: string, event: AgentEvent, taskId?: string) => void) => {
      runtime.observers.add(observer);
      return () => runtime.observers.delete(observer);
    },
    startBackgroundTask: runtime.startBackgroundTask,
    cancelBackgroundTask: runtime.cancelBackgroundTask,
    interruptBackgroundTask: runtime.interruptBackgroundTask,
  }),
}));
vi.mock('../../src/host/tools/utils/userQuestionPrompt', () => ({
  promptUserInChat: runtime.promptUserInChat,
}));
vi.mock('../../src/host/services/voice/voiceWorkEvidence', () => ({
  resolveVoiceWorkOutcome: vi.fn(async () => 'done'),
}));
vi.mock('../../src/host/services/voice/voiceTaskResultProjector', () => ({
  projectVoiceTaskTerminalResult: vi.fn(async () => undefined),
}));
vi.mock('../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock: vi.fn(async () => null),
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getSettings: () => ({ ui: { language: 'zh' }, voice: { live: {} } }) }),
}));
vi.mock('../../src/host/services/planning/taskStore', () => ({ getIncompleteTasks: () => [] }));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: vi.fn(async () => ({ messages: [] })) }),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({
    markLiveVoiceSession: vi.fn(),
    clearLiveVoiceSession: vi.fn(),
  }),
}));
vi.mock('../../src/host/agent/agentRegistry', () => ({ resolveAgent: () => undefined }));
vi.mock('../../src/host/connectors', () => ({ getConnectorRegistry: () => ({ get: () => undefined }) }));

const { beginVoiceDispatch, dispatchVoiceIntent, endVoiceDispatch, pushVoiceTranscript } =
  await import('../../src/host/services/voice/voiceAgentCoordinator');
const { projectVoiceTaskTerminalResult } = await import(
  '../../src/host/services/voice/voiceTaskResultProjector'
);

let workItems: VoiceWorkItem[];
let narrations: VoiceWorkNarration[];

function spawn(index: number, laneKey = `lane-${index}`, submissionKey = `turn-${index}`) {
  return dispatchVoiceIntent({
    kind: 'delegate_task',
    title: `任务${index}`,
    shortName: `短名${index}`,
    laneKey,
    submissionKey,
    prompt: `执行任务${index}`,
  });
}

function latest(id: string): VoiceWorkItem | undefined {
  return [...workItems].reverse().find((item) => item.id === id);
}

beforeEach(() => {
  endVoiceDispatch();
  resetVoiceTaskConcurrencyPoolForTest();
  runtime.perSessionLimit = 2;
  runtime.listeners.clear();
  runtime.observers.clear();
  runtime.startBackgroundTask.mockClear();
  runtime.cancelBackgroundTask.mockClear();
  runtime.interruptBackgroundTask.mockClear();
  runtime.promptUserInChat.mockReset();
  runtime.promptUserInChat.mockResolvedValue({ status: 'timeout' });
  vi.mocked(projectVoiceTaskTerminalResult).mockClear();
  workItems = [];
  narrations = [];
  beginVoiceDispatch({
    neoSessionId: 'session-1',
    voiceSessionId: 'voice-1',
    onWorkItem: (item) => workItems.push(item),
    onWorkFailed: () => undefined,
    onWorkNarration: (narration) => narrations.push(narration),
    onEndCall: () => undefined,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('voice multi-slot coordinator', () => {
  it('starts two different lanes in parallel', async () => {
    pushVoiceTranscript({ role: 'user', text: '同时派两件需要澄清的活。' });
    await spawn(1);
    await spawn(2);

    expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(2);
    const ids = runtime.startBackgroundTask.mock.calls.map((call) => call[0] as string);
    expect(latest(ids[0])).toMatchObject({ shortName: '短名1', status: 'running' });
    expect(latest(ids[1])).toMatchObject({ shortName: '短名2', status: 'running' });
    expect(JSON.stringify(runtime.startBackgroundTask.mock.calls[0][4]))
      .toContain('需要澄清时调用 AskUserQuestion');
  });

  function fillOtherSessions() {
    const pool = getVoiceTaskConcurrencyPool();
    for (let index = 0; pool.hasCapacity(); index++) {
      expect(pool.acquire(`other-session-task-${index}`)).toBe(true);
    }
  }

  it('offers Queue and Don\'t create in that order when other sessions hold all slots', async () => {
    fillOtherSessions();

    const reply = await spawn(9);

    expect(runtime.promptUserInChat).toHaveBeenCalledOnce();
    const [questions, options] = runtime.promptUserInChat.mock.calls[0];
    expect(questions[0].options.map((option) => option.label)).toEqual(['排队', '暂不创建']);
    expect(questions[0].question).toBe('当前后台任务槽位已满，「短名9」要排队等待空闲槽位，还是暂不创建？');
    expect(options).toEqual({ sessionId: 'session-1' });
    expect(reply).toContain('等待回答');
    expect(reply).not.toContain('已经开始');
    expect(workItems).toEqual([]);
    expect(runtime.startBackgroundTask).not.toHaveBeenCalled();
  });

  it.each([1, 3])('keeps Don\'t create last with %i running tasks and at most two replacements', async (count) => {
    if (count === 3) {
      // Exercise truncation beyond the normal two-slot session limit, using the real ledger.
      endVoiceDispatch();
      runtime.perSessionLimit = 3;
      beginVoiceDispatch({
        neoSessionId: 'session-1', voiceSessionId: 'voice-1',
        onWorkItem: (item) => workItems.push(item), onWorkFailed: () => undefined,
        onWorkNarration: (narration) => narrations.push(narration), onEndCall: () => undefined,
      });
    }
    for (let index = 1; index <= count; index++) await spawn(index);
    expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(count);
    fillOtherSessions();

    await spawn(9);

    expect(runtime.promptUserInChat).toHaveBeenCalledOnce();
    const question = runtime.promptUserInChat.mock.calls[0][0][0];
    expect(question.options.map((option) => option.label)).toEqual(count === 1
      ? ['排队', '替换短名1', '暂不创建']
      : ['排队', '替换短名1', '替换短名2', '暂不创建']);
    expect(question.question).toBe('当前后台任务槽位已满，「短名9」要排队等待，还是替换一件本会话的任务？');
  });

  it.each([['暂不创建', 0], ['暂不创建', 1], ['timeout', 0]] as const)(
    'creates and stops nothing after overflow answer %s with %i running tasks', async (answer, count) => {
      if (count) await spawn(1);
      runtime.startBackgroundTask.mockClear();
      const itemsBefore = [...workItems];
      fillOtherSessions();
      if (answer !== 'timeout') runtime.promptUserInChat.mockResolvedValueOnce({
        status: 'answered', response: { requestId: 'overflow', answers: { '任务已满': answer } },
      });
      const admit = vi.spyOn(VoiceTaskSlotLedger.prototype, 'admit');

      await spawn(9);

      expect(runtime.promptUserInChat).toHaveBeenCalledOnce();
      expect(admit).toHaveBeenCalledTimes(1);
      expect(admit).toHaveReturnedWith(expect.objectContaining({ outcome: 'requires_choice' }));
      expect(workItems).toEqual(itemsBefore);
      expect(runtime.startBackgroundTask).not.toHaveBeenCalled();
      expect(runtime.cancelBackgroundTask).not.toHaveBeenCalled();
      expect(runtime.interruptBackgroundTask).not.toHaveBeenCalled();
    },
  );

  it('queues only after the Queue answer and starts when a slot frees', async () => {
    await spawn(1);
    const firstId = runtime.startBackgroundTask.mock.calls[0][0];
    fillOtherSessions();
    runtime.promptUserInChat.mockResolvedValueOnce({
      status: 'answered', response: { requestId: 'overflow', answers: { '任务已满': '排队' } },
    });
    const admit = vi.spyOn(VoiceTaskSlotLedger.prototype, 'admit');

    await spawn(9);

    await vi.waitFor(() => expect(workItems).toContainEqual(expect.objectContaining({ shortName: '短名9', status: 'queued' })));
    expect(admit).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-1', laneKey: 'lane-9', submissionKey: 'turn-9',
    }), { queueWhenFull: true });
    expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(1);
    expect(runtime.cancelBackgroundTask).not.toHaveBeenCalled();
    const queued = workItems.find((item) => item.shortName === '短名9');
    runtime.emit('task_completed', firstId);
    await vi.waitFor(() => expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(2));
    expect(runtime.startBackgroundTask.mock.calls[1].slice(0, 3)).toEqual([queued?.id, 'session-1', '执行任务9']);
    expect(latest(runtime.startBackgroundTask.mock.calls[1][0])).toMatchObject({ status: 'running' });
  });

  it('waits for the selected replacement to stop before starting the new task', async () => {
    await spawn(1);
    await spawn(2);
    const firstId = runtime.startBackgroundTask.mock.calls[0][0];
    const secondId = runtime.startBackgroundTask.mock.calls[1][0];
    runtime.promptUserInChat.mockResolvedValueOnce({
      status: 'answered', response: { requestId: 'overflow', answers: { '任务已满': '替换短名1' } },
    });

    await spawn(9);

    await vi.waitFor(() => expect(runtime.cancelBackgroundTask).toHaveBeenCalledExactlyOnceWith(firstId));
    expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(2);
    expect(latest(secondId)).toMatchObject({ status: 'running' });
    runtime.emit('task_cancelled', firstId);
    await vi.waitFor(() => expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(3));
    expect(runtime.startBackgroundTask.mock.calls[2].slice(1, 3)).toEqual(['session-1', '执行任务9']);
    expect(latest(secondId)).toMatchObject({ status: 'running' });
  });

  it('serializes the same lane until the first task settles', async () => {
    await spawn(1, 'report');
    await spawn(2, 'report');
    expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(1);
    const firstId = runtime.startBackgroundTask.mock.calls[0][0] as string;
    const queued = workItems.find((item) => item.shortName === '短名2');
    expect(queued).toMatchObject({ status: 'queued' });

    runtime.emit('task_completed', firstId);
    await vi.waitFor(() => expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(2));
    expect(runtime.startBackgroundTask.mock.calls[1][0]).toBe(queued?.id);
  });

  it('fails loudly and starts the same-lane successor when a voice run stops reporting terminal events', async () => {
    endVoiceDispatch();
    vi.useFakeTimers();
    beginVoiceDispatch({
      neoSessionId: 'session-1',
      voiceSessionId: 'voice-timeout',
      onWorkItem: (item) => workItems.push(item),
      onWorkFailed: () => undefined,
      onWorkNarration: (narration) => narrations.push(narration),
      onEndCall: () => undefined,
    });
    const startedAt = Date.now();

    await spawn(1, 'report');
    await spawn(2, 'report');
    const firstId = runtime.startBackgroundTask.mock.calls[0][0] as string;
    const queuedId = workItems.find((item) => item.shortName === '短名2')?.id;
    expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(1);

    vi.setSystemTime(startedAt + SESSION_TASK_SLOT_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(latest(firstId)).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('lane「report」占用 2 小时后仍未收到终态事件'),
      failure: {
        code: 'TASK_SLOT_TIMEOUT',
        laneKey: 'report',
        reason: 'terminal_event_timeout',
      },
    });
    expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(2);
    expect(runtime.startBackgroundTask.mock.calls[1][0]).toBe(queuedId);
  });

  it('reuses a duplicate submission key', async () => {
    await spawn(1, 'report', 'same-turn');
    const reply = await spawn(2, 'other', 'same-turn');

    expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(1);
    expect(reply).toContain('reused');
  });

  // 账本用终态决定同一 submissionKey 还能不能重试，而这里是语音侧唯一的 settle 调用点：
  // 它曾经不传终态、吃 settle 的 'completed' 默认值，于是**失败的语音任务被记成成功**，
  // 从此不可重试。参数已改必填 + 四态映射三态，这条钉住行为侧。
  it('a failed voice task stays retryable under the same submission key', async () => {
    await spawn(1, 'report', 'same-turn');
    expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(1);
    const firstId = runtime.startBackgroundTask.mock.calls[0][0] as string;

    runtime.emit('task_error', firstId, { error: '上游超时' });
    await vi.waitFor(() => expect(latest(firstId)).toMatchObject({ status: 'failed' }));

    await spawn(2, 'report', 'same-turn');
    expect(runtime.startBackgroundTask).toHaveBeenCalledTimes(2);
  });

  it('cancels one task by short name without touching its sibling', async () => {
    await spawn(1);
    await spawn(2);
    const firstId = runtime.startBackgroundTask.mock.calls[0][0] as string;
    const secondId = runtime.startBackgroundTask.mock.calls[1][0] as string;

    await dispatchVoiceIntent({ kind: 'cancel_task', target: '短名1' });

    expect(runtime.cancelBackgroundTask).toHaveBeenCalledWith(firstId);
    expect(runtime.cancelBackgroundTask).not.toHaveBeenCalledWith(secondId);
    expect(latest(secondId)).toMatchObject({ status: 'running' });
  });

  it('asks a voice-rendered question when the target is ambiguous', async () => {
    await spawn(1);
    await spawn(2);

    const reply = await dispatchVoiceIntent({ kind: 'cancel_task' });

    expect(runtime.cancelBackgroundTask).not.toHaveBeenCalled();
    expect(runtime.promptUserInChat).toHaveBeenCalledOnce();
    expect(reply).toContain('AskUserQuestion');
  });

  it('deduplicates terminal events per task and prefixes each result with its short name', async () => {
    await spawn(1);
    await spawn(2);
    const firstId = runtime.startBackgroundTask.mock.calls[0][0] as string;
    const secondId = runtime.startBackgroundTask.mock.calls[1][0] as string;
    runtime.emit('task_completed', firstId);
    runtime.emit('task_completed', firstId);
    runtime.emit('task_completed', secondId);

    await vi.waitFor(() => expect(narrations.filter((item) => item.status === 'done')).toHaveLength(2));
    expect(narrations.filter((item) => item.status === 'done').map((item) => item.title)).toEqual([
      '短名1',
      '短名2',
    ]);
  });

  it('keeps concurrent tool result ledgers isolated by background task id', async () => {
    await spawn(1);
    await spawn(2);
    const firstId = runtime.startBackgroundTask.mock.calls[0][0] as string;
    const secondId = runtime.startBackgroundTask.mock.calls[1][0] as string;
    const emitToolResult = (taskId: string, fileName: string) => {
      for (const observer of runtime.observers) {
        observer('session-1', {
          type: 'tool_call_end',
          data: {
            toolCallId: `write-${taskId}`,
            success: true,
            metadata: {
              artifacts: [{
                artifactId: `artifact-${taskId}`,
                kind: 'document',
                role: 'deliverable',
                sourceTool: 'Write',
                createdAt: '2026-08-16T00:00:00.000Z',
                path: `/repo/${fileName}`,
              }],
            },
          },
        }, taskId);
      }
    };
    emitToolResult(firstId, 'first.md');
    emitToolResult(secondId, 'second.md');

    runtime.emit('task_completed', firstId);
    await vi.waitFor(() => expect(projectVoiceTaskTerminalResult).toHaveBeenCalled());
    const firstProjection = vi.mocked(projectVoiceTaskTerminalResult).mock.calls.find(
      (call) => call[1].id === firstId,
    );

    expect(firstProjection?.[5]).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          artifacts: [expect.objectContaining({ path: '/repo/first.md' })],
        }),
      }),
    ]);
    expect(firstProjection?.[5]).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            artifacts: [expect.objectContaining({ path: '/repo/second.md' })],
          }),
        }),
      ]),
    );
  });
});
