import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { findRegisteredSystemEvent } from '../../../src/shared/contract/systemEventRegistry';
import { BACKGROUND_WAKE_DEFER_NOTICE_MS } from '../../../src/shared/constants/sessionCommandCenter';
import type { SessionCommandTask } from '../../../src/host/services/commandCenter/sessionCommandCenter';

// 走默认依赖（产线路径）：唤醒轮失败后落的那句人话必须带登记键，否则渲染端投影层会把
// 无 metadata 的 role:'system' 消息整条跳过，用户什么都看不到。
const h = vi.hoisted(() => ({
  added: [] as Array<{ sessionId: string; message: Message }>,
  emitted: [] as Array<{ sessionId: string; event: { type: string; data: unknown } }>,
  busy: false,
}));

const orchestrator = {
  isProcessing: () => false,
  sendMessage: vi.fn(async () => { throw new Error('Durable Run run-x has no live owner lease'); }),
};
vi.mock('../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => ({
    getSessionState: () => ({ status: h.busy ? 'running' : 'idle' }),
    getWaitingQueue: () => [],
    hasActivePrimaryRun: () => false,
    getOrCreateCurrentOrchestrator: () => orchestrator,
    setSessionContext: vi.fn(),
    setWorkingDirectory: vi.fn(),
    on: vi.fn(),
    onRunIdle: vi.fn(),
    observeAgentEvents: vi.fn(() => () => undefined),
    emitAgentEventForSession: (sessionId: string, event: { type: string; data: unknown }) => {
      h.emitted.push({ sessionId, event });
    },
  }),
}));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async () => ({
      id: 'session-n', type: 'chat', workingDirectory: '/tmp/p',
      messages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }],
    }),
    addMessageToSession: async (sessionId: string, message: Message) => { h.added.push({ sessionId, message }); },
  }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => ({}) }),
}));
vi.mock('../../../src/host/services/core/repositories/QueuedInputRepository', () => ({
  QueuedInputRepository: class { listBySession() { return []; } },
}));
vi.mock('../../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({ isLiveVoiceSession: () => false }),
}));

import { createForegroundWake } from '../../../src/host/services/commandCenter/foregroundWake';

const task = {
  id: 'task-n', sessionId: 'session-n', title: 't', shortName: '报告', laneKey: 'l', submissionKey: 's',
  prompt: 'p', workspaceScope: {}, status: 'completed', attempt: 1, createdAt: 1, updatedAt: 2, summary: 'ok',
} as unknown as SessionCommandTask;

describe('foreground wake failure note (default dependencies)', () => {
  beforeEach(() => { h.added.length = 0; h.emitted.length = 0; h.busy = false; });
  afterEach(() => { vi.useRealTimers(); });

  it('persists and broadcasts a note that the renderer registry recognises', async () => {
    await createForegroundWake()(task, 'completed');

    expect(h.added).toHaveLength(1);
    const { message } = h.added[0];
    expect(message.role).toBe('system');
    const registered = findRegisteredSystemEvent(message.metadata);
    expect(registered?.key).toBe('backgroundWakeFailed');
    expect(message.metadata?.backgroundWakeFailed).toEqual({ taskId: 'task-n', reason: 'owner_missing' });
    expect(h.emitted).toEqual([{ sessionId: 'session-n', event: { type: 'message', data: message } }]);
  });

  it('persists and broadcasts the registered deferred-wake note after the cap', async () => {
    vi.useFakeTimers();
    h.busy = true;
    await createForegroundWake()(task, 'completed');

    expect(h.emitted[0]).toMatchObject({
      sessionId: 'session-n',
      event: { type: 'task_progress', data: { step: '后台任务已完成，等待汇报' } },
    });
    await vi.advanceTimersByTimeAsync(BACKGROUND_WAKE_DEFER_NOTICE_MS);

    expect(h.added).toHaveLength(1);
    const { message } = h.added[0];
    const registered = findRegisteredSystemEvent(message.metadata);
    expect(registered?.key).toBe('backgroundWakeDeferred');
    expect(message.content).toBe('后台任务「t」已完成，结果见上方的任务结果；当前步骤结束后，我会继续汇报。');
    expect(message.metadata?.backgroundWakeDeferred).toEqual({ taskId: 'task-n', outcome: 'completed' });
    expect(h.emitted.at(-1)).toEqual({ sessionId: 'session-n', event: { type: 'message', data: message } });
  });
});
