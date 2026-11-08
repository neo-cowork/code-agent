import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../../src/shared/contract';
import type { SubagentResult } from '../../../../src/host/agent/subagentExecutorTypes';
import type { TaskManager, TaskManagerEvent } from '../../../../src/host/task/TaskManager';
import { getBackgroundSubagentRegistry } from '../../../../src/host/agent/backgroundSubagentRegistry';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';
import {
  SessionCommandCenter,
  type SessionCommandTask,
} from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import {
  createForegroundWake,
  type ForegroundWakeDependencies,
} from '../../../../src/host/services/commandCenter/foregroundWake';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { resetBackgroundTaskLedgerForTest } from '../../../../src/host/task/backgroundTaskLedger';
import {
  getTaskOutput,
  killBackgroundTask,
  startBackgroundTask,
} from '../../../../src/host/tools/shell/backgroundTasks';

const SESSION_ID = 'session-nested-shell';
const LAUNCH_SENTENCE = '后台任务已启动：40 秒后会打印 BG-RR50-DONE-1，完成后我自动汇报结果。本轮结束。';
const RESULT = 'BG-RR50-DONE-1';
const SCOPE = createWorkspaceScope('project-nested-shell', [{
  sourceId: 'source-nested-shell',
  path: process.cwd(),
  role: 'primary',
  access: 'read_write',
}]);

class FakeTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockResolvedValue(undefined);
  interruptBackgroundTask = vi.fn().mockResolvedValue(true);
  cancelBackgroundTask = vi.fn().mockResolvedValue(true);
  setSessionContext = vi.fn();
  setWorkingDirectory = vi.fn();
  private readonly observers = new Set<(sessionId: string, event: AgentEvent, taskId?: string) => void>();

  observeAgentEvents(observer: (sessionId: string, event: AgentEvent, taskId?: string) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  emitAgent(event: AgentEvent, taskId: string): void {
    this.observers.forEach((observer) => observer(SESSION_ID, event, taskId));
  }

  emitTask(event: TaskManagerEvent): void {
    this.emit(event.type, event);
  }

  getSessionState(): { status: string } { return { status: 'idle' }; }
  getWaitingQueue(): string[] { return []; }
  hasActivePrimaryRun(): boolean { return false; }
  onRunIdle(): () => void { return () => undefined; }
}

function createCenterHarness(
  manager: FakeTaskManager,
  sendMessage: (prompt: string) => Promise<void>,
): SessionCommandCenter {
  const orchestrator = { isProcessing: () => false, sendMessage };
  const wakeDependencies: ForegroundWakeDependencies = {
    getTaskManager: () => ({
      ...manager,
      getSessionState: () => manager.getSessionState(),
      getWaitingQueue: () => manager.getWaitingQueue(),
      hasActivePrimaryRun: () => false,
      getOrCreateCurrentOrchestrator: () => orchestrator,
      setSessionContext: manager.setSessionContext,
      setWorkingDirectory: manager.setWorkingDirectory,
      on: manager.on.bind(manager),
      onRunIdle: manager.onRunIdle.bind(manager),
    }) as unknown as ReturnType<ForegroundWakeDependencies['getTaskManager']>,
    loadSession: async () => ({
      id: SESSION_ID,
      title: '后台任务测试',
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
      type: 'chat',
      workingDirectory: process.cwd(),
      createdAt: 1,
      updatedAt: 1,
      messages: [{ id: 'user-1', role: 'user', content: '开始', timestamp: 1 }],
      todos: [],
      messageCount: 1,
    }),
    hasQueuedUserInput: () => false,
    isVoiceSession: () => false,
    recordWakeFailureNote: async () => undefined,
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  return new SessionCommandCenter(manager as unknown as TaskManager, {
    projectTerminalResult: vi.fn(),
    wakeForegroundBrain: createForegroundWake(wakeDependencies),
  });
}

describe('session command task nested shell settlement', () => {
  let center: SessionCommandCenter;
  let nestedShellId: string | undefined;

  beforeEach(() => {
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
  });

  afterEach(async () => {
    center?.dispose();
    if (nestedShellId) {
      const output = await getTaskOutput(nestedShellId);
      if (output?.status === 'running') await killBackgroundTask(nestedShellId);
    }
  });

  it('waits for a nested background shell and wakes once with its real output', async () => {
    const manager = new FakeTaskManager();
    const sendMessage = vi.fn(async (prompt: string) => {
      if (!prompt.includes(LAUNCH_SENTENCE)) return;
      await center.spawn({
        sessionId: SESSION_ID,
        title: '重复等待',
        shortName: 'RR50',
        laneKey: 'bg-rr50-duplicate',
        submissionKey: 'bg-rr50-duplicate',
        prompt: '重复执行同一任务',
        workspaceScope: SCOPE,
      });
    });
    center = createCenterHarness(manager, sendMessage);
    const spawned = await center.spawn({
      sessionId: SESSION_ID,
      title: '等待 40 秒后打印',
      shortName: 'RR50',
      laneKey: 'bg-rr50',
      submissionKey: 'bg-rr50-1',
      prompt: '等待 40 秒后打印 BG-RR50-DONE-1',
      workspaceScope: SCOPE,
    });
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');

    const shell = startBackgroundTask(
      `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('${RESULT}'), 250)"`,
      process.cwd(),
      2_000,
      { sessionId: SESSION_ID, toolCallId: 'bash-1' },
    );
    if (!shell.success || !shell.taskId) throw new Error(shell.error ?? 'nested shell did not start');
    nestedShellId = shell.taskId;
    manager.emitAgent({
      type: 'tool_call_start',
      data: { id: 'bash-1', name: 'Bash', arguments: { command: 'sleep 40 && echo BG-RR50-DONE-1', run_in_background: true } },
    }, spawned.task.id);
    manager.emitAgent({
      type: 'tool_call_end',
      data: {
        toolCallId: 'bash-1',
        success: true,
        output: `Background task started.\n<task-id>${nestedShellId}</task-id>`,
        duration: 1,
        metadata: { background: true, taskId: nestedShellId },
      },
    }, spawned.task.id);
    manager.emitTask({
      type: 'task_completed',
      sessionId: SESSION_ID,
      data: { taskId: spawned.task.id, conclusion: LAUNCH_SENTENCE },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const pending = center.list(SESSION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('running');
    expect(pending[0]?.summary).toBeUndefined();
    expect(pending[0]?.resultText).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    const settled = center.list(SESSION_ID);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      status: 'completed',
      shortName: 'RR50',
      summary: RESULT,
      resultText: RESULT,
    } satisfies Partial<SessionCommandTask>);
    const wakePrompt = sendMessage.mock.calls[0]?.[0] ?? '';
    expect(wakePrompt).toContain(`后台任务 RR50 已完成，结果摘要：${RESULT}`);
    expect(wakePrompt).not.toContain(LAUNCH_SENTENCE);
    expect(manager.startBackgroundTask).toHaveBeenCalledTimes(1);
  });

  it('waits for a background subagent returned by spawn_agent before waking', async () => {
    const manager = new FakeTaskManager();
    const sendMessage = vi.fn(async () => undefined);
    center = createCenterHarness(manager, sendMessage);
    const spawned = await center.spawn({
      sessionId: SESSION_ID,
      title: '等待后台子 agent',
      shortName: 'RR50-SUBAGENT',
      laneKey: 'bg-rr50-subagent',
      submissionKey: 'bg-rr50-subagent-1',
      prompt: '等待后台子 agent 完成',
      workspaceScope: SCOPE,
    });
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');

    let release!: (result: SubagentResult) => void;
    const pending = new Promise<SubagentResult>((resolve) => { release = resolve; });
    const agentId = getBackgroundSubagentRegistry().spawn(() => pending, {
      sessionId: SESSION_ID,
      runId: 'parent-run-rr50-subagent',
      title: 'RR50 background child',
    });
    manager.emitAgent({
      type: 'tool_call_start',
      data: { id: 'spawn-agent-1', name: 'spawn_agent', arguments: { run_in_background: true } },
    }, spawned.task.id);
    manager.emitAgent({
      type: 'tool_call_end',
      data: {
        toolCallId: 'spawn-agent-1',
        success: true,
        output: `已在后台启动子 agent ${agentId}`,
        duration: 1,
        metadata: { background: true, agentId, taskId: agentId, transferredToBackground: true, result: { background: true } },
      },
    }, spawned.task.id);
    manager.emitTask({
      type: 'task_completed',
      sessionId: SESSION_ID,
      data: { taskId: spawned.task.id, conclusion: LAUNCH_SENTENCE },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getBackgroundSubagentRegistry().getStatus(agentId)?.status).toBe('running');
    expect(center.list(SESSION_ID)[0]?.status).toBe('running');
    expect(sendMessage).not.toHaveBeenCalled();

    release({ success: true, output: RESULT, toolsUsed: ['Bash'], iterations: 1 });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(getBackgroundSubagentRegistry().getStatus(agentId)?.status).toBe('completed');
    expect(center.list(SESSION_ID)[0]).toMatchObject({
      status: 'completed',
      shortName: 'RR50-SUBAGENT',
      summary: RESULT,
      resultText: RESULT,
    } satisfies Partial<SessionCommandTask>);
    expect(sendMessage.mock.calls[0]?.[0]).toContain(`后台任务 RR50-SUBAGENT 已完成，结果摘要：${RESULT}`);
    expect(sendMessage.mock.calls[0]?.[0]).not.toContain(LAUNCH_SENTENCE);
    expect(manager.startBackgroundTask).toHaveBeenCalledTimes(1);
  });
});
