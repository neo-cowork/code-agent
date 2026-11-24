// 后台父行在委派子任务（含排队）还在途时不能收口。收口走生产入口：
// settleBackgroundOnTaskComplete / closeBackgroundRunAtTerminal / settleWebTurnBackgroundRun。
// 指挥台是真 SessionCommandCenter，只有构造缝上的 TaskManager 是假的。

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/shared/contract';
import type { TaskManager, TaskManagerEvent } from '../../../src/host/task/TaskManager';
import { BACKGROUND_TASK_CANCELLED, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../../src/shared/constants';

const sessionManagerState = vi.hoisted(() => ({
  getSession: vi.fn(),
}));
const notifyState = vi.hoisted(() => ({
  notifyTaskComplete: vi.fn(),
  notifyNeedsInput: vi.fn(),
}));
const logs = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../src/host/session/sessionTitleHostPrompt', () => ({ readUiLanguage: () => 'zh' }));
vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
  notificationService: notifyState,
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: logs,
  createLogger: () => logs,
}));
vi.mock('../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  AppWindow: class MockAppWindow {
    static getAllWindows() { return []; }
  },
  broadcastToRenderer: vi.fn(),
}));

import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import {
  getBackgroundTaskManager,
  resetBackgroundTaskManager,
} from '../../../src/host/session/backgroundTaskManager';
import { settleWebTurnBackgroundRun } from '../../../src/host/session/backgroundChildHold';
import {
  closeBackgroundRunAtTerminal,
  settleBackgroundOnTaskComplete,
  settleBackgroundRunOnRejection,
} from '../../../src/host/task/backgroundTaskTerminal';
import { resetBackgroundTaskLedgerForTest } from '../../../src/host/task/backgroundTaskLedger';
import {
  SessionCommandCenter,
  resetSessionCommandCenterForTest,
  type SessionCommandTask,
} from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';

const SCOPE = createWorkspaceScope('project-child-hold', [{
  sourceId: 'root',
  path: '/tmp/child-hold-project',
  role: 'primary',
  access: 'read_write',
}]);

const primary = { active: false };

class FakeTaskManager extends EventEmitter {
  readonly startBackgroundTask = vi.fn().mockResolvedValue(undefined);
  readonly cancelBackgroundTask = vi.fn().mockResolvedValue(true);
  private readonly agentObservers = new Set<(sessionId: string, event: AgentEvent, taskId?: string) => void>();
  private readonly idleListeners = new Set<() => void>();

  hasActivePrimaryRun(): boolean {
    return primary.active;
  }

  onRunIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => { this.idleListeners.delete(listener); };
  }

  emitIdle(): void {
    for (const listener of [...this.idleListeners]) listener();
  }

  observeAgentEvents(observer: (sessionId: string, event: AgentEvent, taskId?: string) => void): () => void {
    this.agentObservers.add(observer);
    return () => { this.agentObservers.delete(observer); };
  }

  emitAgent(sessionId: string, event: AgentEvent, taskId?: string): void {
    for (const observer of this.agentObservers) observer(sessionId, event, taskId);
  }

  emitTask(event: TaskManagerEvent): void {
    this.emit(event.type, event);
  }
}

type ChildWake = (task: SessionCommandTask, status: 'completed' | 'failed' | 'cancelled') => Promise<void>;

let manager: FakeTaskManager;
let center: SessionCommandCenter;
let wake: ReturnType<typeof vi.fn<ChildWake>>;

function deferral(sessionId: string, inFlightChildren: number) {
  return [
    'Deferring background run settlement until delegated children finish',
    expect.objectContaining({ sessionId, inFlightChildren }),
  ] as const;
}

async function background(sessionId: string): Promise<void> {
  expect(await getBackgroundTaskManager().moveToBackground(sessionId)).toBe(true);
}

async function expectParentNotice(sessionId: string, extra: Record<string, unknown> = {}): Promise<void> {
  await vi.waitFor(() => expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1));
  expect(notifyState.notifyTaskComplete).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId, ...extra }),
    expect.objectContaining({ force: true }),
  );
}

async function spawn(sessionId: string, index: number, laneKey: string) {
  const result = await center.spawn({
    sessionId,
    title: `删除临时文件 ${index}`,
    shortName: `清理${index}`,
    laneKey,
    submissionKey: `${sessionId}-${index}`,
    prompt: `删除 export-cache-${index}.tmp`,
    workspaceScope: SCOPE,
    queueWhenFull: true,
  });
  if (result.outcome === 'requires_choice') throw new Error(`spawn ${index} was not admitted`);
  return result.task;
}

function row(sessionId: string) {
  return getBackgroundTaskManager().getAllTasks().find((task) => task.sessionId === sessionId);
}

async function finishChild(sessionId: string, taskId: string, conclusion = '三个临时文件已经删除。'): Promise<void> {
  manager.emitTask({
    type: 'task_completed',
    sessionId,
    data: { taskId, conclusion },
  });
  await vi.waitFor(() => expect(center.list(sessionId).some((task) => task.id === taskId && task.status === 'completed')).toBe(true));
}

beforeEach(() => {
  primary.active = false;
  resetSessionTaskConcurrencyPoolForTest();
  resetBackgroundTaskLedgerForTest();
  resetBackgroundTaskManager();
  resetSessionCommandCenterForTest();
  sessionManagerState.getSession.mockReset().mockImplementation(async (id: string) => ({
    id,
    title: '清理临时文件',
  }));
  notifyState.notifyTaskComplete.mockClear();
  logs.info.mockClear();
  logs.warn.mockClear();
  wake = vi.fn<ChildWake>(async () => undefined);
  manager = new FakeTaskManager();
  center = new SessionCommandCenter(manager as unknown as TaskManager, {
    projectTerminalResult: vi.fn().mockResolvedValue(undefined),
    wakeForegroundBrain: wake,
  });
  resetSessionCommandCenterForTest(center);
});

afterEach(() => {
  resetSessionCommandCenterForTest();
  resetBackgroundTaskManager();
});

describe('background parent settlement waits for delegated children', () => {
  it('settleBackgroundOnTaskComplete defers while a delegated child is in flight and settles after it ends', async () => {
    const sessionId = 'session-task-complete';
    await background(sessionId);
    primary.active = true;
    const task = await spawn(sessionId, 1, 'cleanup');

    await settleBackgroundOnTaskComplete(sessionId, sessionId, { summary: '父轮说已经交给后台' });

    expect(row(sessionId)?.status).toBe('running');
    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();
    expect(logs.info).toHaveBeenCalledWith(...deferral(sessionId, 1));

    await finishChild(sessionId, task.id);
    expect(row(sessionId)?.status).toBe('running');
    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();

    primary.active = false;
    await settleBackgroundOnTaskComplete(sessionId, sessionId, { summary: '临时文件已删除' });

    expect(row(sessionId)?.status).toBe('completed');
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, summary: '临时文件已删除' }),
      expect.objectContaining({ force: true }),
    );
  });

  it('closeBackgroundRunAtTerminal defers while a delegated child is in flight and settles after it ends', async () => {
    const sessionId = 'session-agent-complete';
    await background(sessionId);
    primary.active = true;
    const task = await spawn(sessionId, 1, 'cleanup');

    await closeBackgroundRunAtTerminal(sessionId, 'agent_complete', new Map());

    expect(row(sessionId)?.status).toBe('running');
    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();
    expect(logs.info).toHaveBeenCalledWith(...deferral(sessionId, 1));

    await finishChild(sessionId, task.id);
    expect(row(sessionId)?.status).toBe('running');

    primary.active = false;
    await closeBackgroundRunAtTerminal(sessionId, 'agent_complete', new Map());

    expect(row(sessionId)?.status).toBe('completed');
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
    await closeBackgroundRunAtTerminal(sessionId, 'agent_complete', new Map());
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
  });

  it('settleWebTurnBackgroundRun defers a background parent with a child and settles immediately with none', async () => {
    const busy = 'session-web-busy';
    const idle = 'session-web-idle';
    await background(busy);
    await background(idle);
    await spawn(busy, 1, 'cleanup');
    logs.info.mockClear();

    await settleWebTurnBackgroundRun(busy, { status: 'completed' });
    await settleWebTurnBackgroundRun(idle, { status: 'completed' });

    expect(row(busy)?.status).toBe('running');
    expect(row(idle)?.status).toBe('completed');
    expect(logs.info).toHaveBeenCalledWith(...deferral(busy, 1));
    expect(logs.info).not.toHaveBeenCalledWith(...deferral(idle, 0));
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: idle }),
      expect.objectContaining({ force: true }),
    );
  });

  it('settleBackgroundRunOnRejection defers while a delegated child is in flight', async () => {
    const sessionId = 'session-reject';
    await background(sessionId);
    await spawn(sessionId, 1, 'cleanup');

    await settleBackgroundRunOnRejection(sessionId, 'parent run rejected');

    expect(row(sessionId)?.status).toBe('running');
    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();
    expect(logs.info).toHaveBeenCalledWith(...deferral(sessionId, 1));
  });

  it('a queued delegated child counts as in flight and the last child settles the row once', async () => {
    const sessionId = 'session-queued';
    await background(sessionId);
    const first = await spawn(sessionId, 1, 'cleanup');
    const second = await spawn(sessionId, 2, 'cleanup');
    expect(center.active(sessionId).map((task) => task.status)).toEqual(['running', 'queued']);

    await settleBackgroundOnTaskComplete(sessionId, sessionId, { summary: '还没删完' });
    expect(logs.info).toHaveBeenCalledWith(...deferral(sessionId, 2));
    expect(row(sessionId)?.status).toBe('running');

    await finishChild(sessionId, first.id);
    expect(center.active(sessionId)).toEqual([expect.objectContaining({ id: second.id, status: 'running' })]);
    expect(row(sessionId)?.status).toBe('running');
    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();

    await finishChild(sessionId, second.id);
    await expectParentNotice(sessionId);
    expect(logs.info).toHaveBeenCalledWith(
      'Settling deferred background run from delegated child',
      expect.objectContaining({ sessionId, taskId: second.id, status: 'completed' }),
    );
  });

  it('step_cap skips the wake and the fallback settles the background row once as failed', async () => {
    const sessionId = 'session-step-cap';
    await background(sessionId);
    const task = await spawn(sessionId, 1, 'cleanup');
    manager.emitAgent(sessionId, {
      type: 'error',
      data: { code: RUN_ERROR_CODE_MAX_ITERATIONS, message: 'cap reached' },
    }, task.id);
    manager.emitTask({
      type: 'task_completed',
      sessionId,
      data: { taskId: task.id, conclusion: '只删掉了一部分。' },
    });

    await vi.waitFor(() => expect(center.list(sessionId)[0]?.stopped?.kind).toBe('step_cap'));
    await expectParentNotice(sessionId, { succeeded: false });
    expect(row(sessionId)?.status).toBe('failed');
    expect(wake).not.toHaveBeenCalled();
    expect(logs.info).toHaveBeenCalledWith(
      'foreground_wake_skipped_stop_note_delivered',
      expect.objectContaining({ taskId: task.id, kind: 'step_cap' }),
    );
    await settleBackgroundOnTaskComplete(sessionId, sessionId, { summary: '迟到的完成' });
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
  });

  it('no_conclusion skips the wake and the fallback settles the background row once as failed', async () => {
    const sessionId = 'session-no-conclusion';
    await background(sessionId);
    const task = await spawn(sessionId, 1, 'cleanup');
    manager.emitTask({ type: 'task_completed', sessionId, data: { taskId: task.id, conclusion: '' } });

    await vi.waitFor(() => expect(center.list(sessionId)[0]?.stopped?.kind).toBe('no_conclusion'));
    await expectParentNotice(sessionId, { succeeded: false });
    expect(row(sessionId)?.status).toBe('failed');
    expect(wake).not.toHaveBeenCalled();
  });

  it('a cancelled child settles the background row once as interrupted', async () => {
    const sessionId = 'session-cancelled';
    await background(sessionId);
    const task = await spawn(sessionId, 1, 'cleanup');
    manager.emitTask({ type: 'task_cancelled', sessionId, data: { taskId: task.id, detail: '任务已取消。' } });

    await expectParentNotice(sessionId);
    expect(row(sessionId)?.status).toBe('completed');
    expect(row(sessionId)?.completionMessage).toBe(BACKGROUND_TASK_CANCELLED);
    expect(logs.info).toHaveBeenCalledWith(
      'Settling deferred background run from delegated child',
      expect.objectContaining({ sessionId, status: 'cancelled' }),
    );
  });

  it('a background run with no children still settles immediately', async () => {
    const sessionId = 'session-no-children';
    await background(sessionId);
    logs.info.mockClear();

    await settleBackgroundOnTaskComplete(sessionId, sessionId, { summary: '没有子任务' });

    expect(row(sessionId)?.status).toBe('completed');
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
    expect(logs.info).not.toHaveBeenCalledWith(
      'Deferring background run settlement until delegated children finish',
      expect.anything(),
    );
  });

  it('fires the deferred fallback when the primary run goes idle after the child already ended', async () => {
    const sessionId = 'session-idle';
    await background(sessionId);
    primary.active = true;
    const task = await spawn(sessionId, 1, 'cleanup');
    await settleBackgroundOnTaskComplete(sessionId, sessionId, { summary: '先别收' });
    await finishChild(sessionId, task.id);

    expect(row(sessionId)?.status).toBe('running');
    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();

    primary.active = false;
    manager.emitIdle();
    await expectParentNotice(sessionId);
    expect(row(sessionId)?.status).toBe('completed');
    expect(logs.info).toHaveBeenCalledWith(
      'Settling deferred background run from delegated child',
      expect.objectContaining({ sessionId, status: 'completed' }),
    );
  });

  it('skips the sub-task completion banner while a delegated child is still in flight', async () => {
    const sessionId = 'session-banner';
    await background(sessionId);
    await spawn(sessionId, 1, 'cleanup');

    await settleBackgroundOnTaskComplete(sessionId, 'child-task-id', { summary: '子任务自己的完成' });

    expect(notifyState.notifyTaskComplete).not.toHaveBeenCalled();
    expect(row(sessionId)?.status).toBe('running');
    expect(logs.info).toHaveBeenCalledWith(
      'sub-task completion banner skipped: delegated children still in flight',
      expect.objectContaining({ sessionId, eventKey: 'child-task-id', inFlightChildren: 1 }),
    );
  });

  it('foreground sessions settle exactly as before and do not defer', async () => {
    const sessionId = 'session-foreground';
    await spawn(sessionId, 1, 'cleanup');
    logs.info.mockClear();

    await settleBackgroundOnTaskComplete(sessionId, sessionId, { summary: '前台完成' });

    expect(getBackgroundTaskManager().getAllTasks()).toEqual([]);
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledTimes(1);
    expect(notifyState.notifyTaskComplete).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, summary: '前台完成' }),
    );
    expect(logs.info).not.toHaveBeenCalledWith(
      'Deferring background run settlement until delegated children finish',
      expect.anything(),
    );
  });
});
