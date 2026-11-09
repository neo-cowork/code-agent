import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskManager, TaskManagerEvent } from '../../../../src/host/task/TaskManager';
import type { AgentEvent } from '../../../../src/shared/contract';
import {
  SessionCommandCenter,
  type SessionCommandTask,
} from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import { createForegroundWake } from '../../../../src/host/services/commandCenter/foregroundWake';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { resetBackgroundTaskLedgerForTest } from '../../../../src/host/task/backgroundTaskLedger';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';
import {
  getBackgroundTask,
  killBackgroundTask,
  startBackgroundTask,
} from '../../../../src/host/tools/shell/backgroundTasks';

const SCOPE = createWorkspaceScope('project-hold', [{
  sourceId: 'source-hold',
  path: '/tmp/hold-project',
  role: 'primary',
  access: 'read_write',
}]);

class FakeTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockResolvedValue(undefined);
  cancelBackgroundTask = vi.fn().mockResolvedValue(false);
  private readonly observers = new Set<(sessionId: string, event: AgentEvent, taskId?: string) => void>();
  observeAgentEvents(observer: (sessionId: string, event: AgentEvent, taskId?: string) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }
  emitAgent(sessionId: string, event: AgentEvent, taskId: string): void {
    this.observers.forEach((observer) => observer(sessionId, event, taskId));
  }
  emitTask(event: TaskManagerEvent): void {
    this.emit(event.type, event);
  }
}

const LAUNCH_SENTENCES = [
  '后台任务已启动：40 秒后会打印 BG-RR50-DONE-1，完成后我自动汇报结果。本轮结束。',
  '后台任务「RR50」已开始，40 秒后会打印 BG-RR50-DONE-1，结果回来后我会自动汇报。',
  '已启动后台任务：40 秒后打印 BG-RR50-DONE-1',
  'started in the background',
];

let dataDir: string;
let previousDataDir: string | undefined;
let seq = 0;

function startShell(command: string, maxRuntimeMs = 30_000): string {
  const started = startBackgroundTask(command, dataDir, maxRuntimeMs);
  if (!started.success || !started.taskId) throw new Error(started.error ?? 'shell did not start');
  return started.taskId;
}

async function waitForShellExit(shellId: string): Promise<void> {
  for (let i = 0; i < 200 && getBackgroundTask(shellId)?.status === 'running'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(check()).toBe(true);
}

interface Harness {
  manager: FakeTaskManager;
  center: SessionCommandCenter;
  woken: Array<{ task: SessionCommandTask; status: string; resultText?: string }>;
  task: SessionCommandTask;
  status(): string | undefined;
  callBash(shellId: string | undefined, callId: string): void;
  callTool(name: string, callId: string): void;
  complete(conclusion?: string): void;
}

async function harness(wakeOverride?: (task: SessionCommandTask, status: string) => Promise<void>): Promise<Harness> {
  const manager = new FakeTaskManager();
  const woken: Harness['woken'] = [];
  const center = new SessionCommandCenter(manager as unknown as TaskManager, {
    projectTerminalResult: vi.fn(),
    wakeForegroundBrain: vi.fn(async (task, status) => {
      woken.push({ task: { ...task }, status, resultText: task.resultText });
      await wakeOverride?.(task, status);
    }),
  });
  seq += 1;
  const spawned = await center.spawn({
    sessionId: 'session-hold',
    title: '后台任务',
    shortName: 'RR50',
    laneKey: `lane-${seq}`,
    submissionKey: `submission-${seq}`,
    prompt: '后台跑一个任务',
    workspaceScope: SCOPE,
  });
  if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission');
  const task = spawned.task;
  manager.emitTask({ type: 'task_started', sessionId: 'session-hold', data: { taskId: task.id } } as TaskManagerEvent);
  const callTool = (name: string, callId: string, metadata?: Record<string, unknown>) => {
    manager.emitAgent('session-hold', { type: 'tool_call_start', data: { id: callId, name, arguments: {} } } as AgentEvent, task.id);
    manager.emitAgent('session-hold', {
      type: 'tool_call_end',
      data: { toolCallId: callId, success: true, output: 'ok', ...(metadata ? { metadata } : {}) },
    } as AgentEvent, task.id);
  };
  return {
    manager,
    center,
    woken,
    task,
    status: () => center.list('session-hold').find((entry) => entry.id === task.id)?.status,
    callBash: (shellId, callId) => callTool('Bash', callId, shellId ? { background: true, taskId: shellId } : undefined),
    callTool: (name, callId) => callTool(name, callId),
    complete: (conclusion) => manager.emitTask({
      type: 'task_completed',
      sessionId: 'session-hold',
      data: { taskId: task.id, ...(conclusion === undefined ? {} : { conclusion }) },
    } as TaskManagerEvent),
  };
}

describe('SessionCommandCenter holds settle while the child own background shell is running', () => {
  let current: Harness | undefined;

  beforeAll(() => {
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-hold-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
  });
  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
  });
  afterEach(() => {
    current?.center.dispose();
    current = undefined;
  });

  it.each(LAUNCH_SENTENCES)('defers a launch-only ending (%s) and wakes with the shell result', async (sentence) => {
    const h = current = await harness();
    const shellId = startShell('sleep 1; echo BG-RR50-DONE-1');
    h.callBash(shellId, 'call-bg');
    h.complete(sentence);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(h.status()).toBe('running');
    expect(h.woken).toHaveLength(0);

    await waitFor(() => h.woken.length === 1);
    expect(h.woken[0].status).toBe('completed');
    expect(h.woken[0].resultText).toContain('BG-RR50-DONE-1');
    expect(h.woken[0].resultText).toContain(sentence);
    expect(h.status()).toBe('completed');
  });

  it('the first wake prompt carries the shell result, not the launch sentence alone', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { isProcessing: () => false, sendMessage };
    const wakeManager = {
      getSessionState: () => ({ status: 'idle' }),
      getWaitingQueue: () => [] as string[],
      hasActivePrimaryRun: () => false,
      getOrCreateCurrentOrchestrator: () => orchestrator,
      setSessionContext: vi.fn(),
      setWorkingDirectory: vi.fn(),
      on: vi.fn(),
      onRunIdle: vi.fn(),
    };
    const wake = createForegroundWake({
      getTaskManager: () => wakeManager as never,
      loadSession: vi.fn(async () => ({
        id: 'session-hold', title: '会话', modelConfig: { provider: 'openai', model: 'test' }, type: 'chat',
        workingDirectory: '/tmp/hold-project', createdAt: 1, updatedAt: 1,
        messages: [{ id: 'user-1', role: 'user', content: '开始', timestamp: 1 }], todos: [], messageCount: 1,
      }) as never),
      hasQueuedUserInput: () => false,
      isVoiceSession: () => false,
      recordWakeFailureNote: vi.fn(async () => undefined),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const h = current = await harness((task, status) => wake(task, status as 'completed'));
    const shellId = startShell('sleep 1; echo BG-RR50-DONE-1');
    h.callBash(shellId, 'call-bg');
    h.complete(LAUNCH_SENTENCES[1]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sendMessage).not.toHaveBeenCalled();
    await waitFor(() => sendMessage.mock.calls.length === 1);
    expect(sendMessage.mock.calls[0][0]).toContain('BG-RR50-DONE-1');
  });

  it('defers when the launch ending has an empty conclusion', async () => {
    const h = current = await harness();
    const shellId = startShell('sleep 1; echo BG-RR50-DONE-1');
    h.callBash(shellId, 'call-bg');
    h.complete(undefined);
    expect(h.status()).toBe('running');
    await waitFor(() => h.woken.length === 1);
    expect(h.woken[0].resultText).toContain('BG-RR50-DONE-1');
  });

  it('settles at once when a later tool call follows the launch (dev-server shape)', async () => {
    const h = current = await harness();
    const shellId = startShell('sleep 5');
    h.callBash(shellId, 'call-bg');
    h.callTool('Bash', 'call-curl');
    h.complete('服务已在 3000 端口跑起来，curl 返回 200。');
    await waitFor(() => h.woken.length === 1);
    expect(h.woken[0].resultText).toBe('服务已在 3000 端口跑起来，curl 返回 200。');
    expect(h.status()).toBe('completed');
    await killBackgroundTask(shellId);
  });

  it('settles at once when the shell already exited before the child ended', async () => {
    const h = current = await harness();
    const shellId = startShell('echo quick');
    h.callBash(shellId, 'call-bg');
    await waitForShellExit(shellId);
    h.complete('已完成。');
    await waitFor(() => h.woken.length === 1);
    expect(h.woken[0].resultText).toBe('已完成。');
  });

  it('settles at once when no background shell was launched', async () => {
    const h = current = await harness();
    h.callBash(undefined, 'call-fg');
    h.complete('普通结论');
    await waitFor(() => h.woken.length === 1);
    expect(h.woken[0].resultText).toBe('普通结论');
  });

  it('keeps status completed and reports the exit status when the shell fails', async () => {
    const h = current = await harness();
    const shellId = startShell('sleep 1; echo oops >&2; exit 3');
    h.callBash(shellId, 'call-bg');
    h.complete('后台任务已启动，结果回来后汇报。');
    await waitFor(() => h.woken.length === 1);
    expect(h.woken[0].status).toBe('completed');
    expect(h.status()).toBe('completed');
    expect(h.woken[0].resultText).toContain('退出码 3');
    expect(h.woken[0].resultText).toContain('oops');
  });

  it('keeps status completed when the shell is killed', async () => {
    const h = current = await harness();
    const shellId = startShell('sleep 20');
    h.callBash(shellId, 'call-bg');
    h.complete('已启动。');
    await killBackgroundTask(shellId);
    await waitFor(() => h.woken.length === 1);
    expect(h.woken[0].status).toBe('completed');
    expect(h.woken[0].resultText).toContain('没有成功完成');
  });

  it('drops the held state when the task is cancelled', async () => {
    const h = current = await harness();
    const shellId = startShell('sleep 1; echo late');
    h.callBash(shellId, 'call-bg');
    h.complete('已启动。');
    const cancelled = await h.center.cancel('session-hold', h.task.id);
    expect(cancelled.outcome).toBe('resolved');
    expect(h.status()).toBe('cancelled');
    await waitForShellExit(shellId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.woken).toHaveLength(1);
    expect(h.woken[0].status).toBe('cancelled');
  });

  it('settles with a still-running note when the deferral bound is reached', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let shellId: string | undefined;
    try {
      const h = current = await harness();
      shellId = startShell('sleep 20', 20 * 60_000);
      h.callBash(shellId, 'call-bg');
      h.complete('已启动。');
      expect(h.status()).toBe('running');
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      expect(h.status()).toBe('completed');
      expect(h.woken[0].resultText).toContain('后台命令仍在运行');
    } finally {
      vi.useRealTimers();
      if (shellId) await killBackgroundTask(shellId);
    }
  });
});
