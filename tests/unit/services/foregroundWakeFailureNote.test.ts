import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message } from '../../../src/shared/contract';
import { findRegisteredSystemEvent } from '../../../src/shared/contract/systemEventRegistry';
import type { SessionCommandTask } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import type { AgentOrchestrator } from '../../../src/host/agent/agentOrchestrator';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

// 走默认依赖（产线路径）：唤醒轮失败后落的那句人话必须带登记键，否则渲染端投影层会把
// 无 metadata 的 role:'system' 消息整条跳过，用户什么都看不到。
const h = vi.hoisted(() => ({
  added: [] as Array<{ sessionId: string; message: Message }>,
  emitted: [] as Array<{ sessionId: string; event: AgentEvent }>,
}));

const orchestrator = {
  isProcessing: () => false,
  sendMessage: vi.fn<AgentOrchestrator['sendMessage']>(async () => {
    throw new Error('Durable Run run-x has no live owner lease');
  }),
};
vi.mock('../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => ({
    getSessionState: () => ({ status: 'idle' }),
    getWaitingQueue: () => [],
    hasActivePrimaryRun: () => false,
    getOrCreateCurrentOrchestrator: () => orchestrator,
    setSessionContext: vi.fn(),
    setWorkingDirectory: vi.fn(),
    on: vi.fn(),
    onRunIdle: vi.fn(),
    emitAgentEventForSession: (sessionId: string, event: AgentEvent) => {
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

const task: SessionCommandTask = {
  id: 'task-n', sessionId: 'session-n', title: 't', shortName: '报告', laneKey: 'l', submissionKey: 's',
  prompt: 'p', workspaceScope: createWorkspaceScope('wake-note-project', [{
    sourceId: 'wake-note-source', path: '/tmp/p', role: 'primary', access: 'read_write',
  }]), status: 'completed', attempt: 1, createdAt: 1, updatedAt: 2, summary: 'ok',
};

describe('foreground wake failure note (default dependencies)', () => {
  beforeEach(() => {
    h.added.length = 0;
    h.emitted.length = 0;
    orchestrator.sendMessage.mockImplementation(async () => {
      throw new Error('Durable Run run-x has no live owner lease');
    });
  });

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

  it('persists and broadcasts one registered note when a resolving wake reports RUN_FAILED', async () => {
    orchestrator.sendMessage.mockImplementationOnce(async (_prompt, _attachments, options) => {
      options?.terminalErrorSink?.({ code: 'RUN_FAILED', message: '401 invalid api key' });
    });

    await createForegroundWake()(task, 'completed');

    expect(h.added).toHaveLength(1);
    const { message } = h.added[0];
    expect(message.metadata?.backgroundWakeFailed).toEqual({ taskId: 'task-n', reason: 'wake_failed' });
    expect(h.emitted.filter((e) => e.event.type === 'error')).toEqual([]);
    expect(h.emitted).toEqual([{ sessionId: 'session-n', event: { type: 'message', data: message } }]);
  });
});
