import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message } from '../../../src/shared/contract';
import { findRegisteredSystemEvent } from '../../../src/shared/contract/systemEventRegistry';
import {
  BACKGROUND_WAKE_DEFER_NOTICE_MS,
  BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS,
  BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS,
} from '../../../src/shared/constants/sessionCommandCenter';
import type { SessionCommandTask } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import type { AgentOrchestrator } from '../../../src/host/agent/agentOrchestrator';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

// 走默认依赖（产线路径）：唤醒轮失败后落的那句人话必须带登记键，否则渲染端投影层会把
// 无 metadata 的 role:'system' 消息整条跳过，用户什么都看不到。
const h = vi.hoisted(() => ({
  added: [] as Array<{ sessionId: string; message: Message }>,
  emitted: [] as Array<{ sessionId: string; event: AgentEvent }>,
  busy: false,
  accessible: true,
}));

const orchestrator = {
  isProcessing: () => false,
  sendMessage: vi.fn<AgentOrchestrator['sendMessage']>(async () => {
    throw new Error('Durable Run run-x has no live owner lease');
  }),
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
    emitAgentEventForSession: (sessionId: string, event: AgentEvent) => {
      h.emitted.push({ sessionId, event });
    },
  }),
}));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async () => (h.accessible ? {
      id: 'session-n', type: 'chat', workingDirectory: '/tmp/p',
      messages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }],
    } : null),
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

import {
  createForegroundWake,
  formatBackgroundWakeFailureNote,
} from '../../../src/host/services/commandCenter/foregroundWake';
import { backgroundPanelZh, backgroundPanelEn } from '../../../src/renderer/i18n/backgroundPanel';
import { interpolate } from '../../../src/renderer/i18n/interpolate';
import { recordBackgroundWakeFailureNoteWithOwnerRetry } from '../../../src/host/services/commandCenter/backgroundWakeNoteRetry';

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
    h.busy = false;
    h.accessible = true;
    orchestrator.sendMessage.mockImplementation(async () => {
      throw new Error('Durable Run run-x has no live owner lease');
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('persists and broadcasts a note that the renderer registry recognises', async () => {
    await createForegroundWake()(task, 'completed');

    expect(h.added).toHaveLength(1);
    const { message } = h.added[0];
    expect(message.role).toBe('system');
    const registered = findRegisteredSystemEvent(message.metadata);
    expect(registered?.key).toBe('backgroundWakeFailed');
    expect(message.content).toBe(formatBackgroundWakeFailureNote(task.shortName, 'owner_missing'));
    expect(message.content).toBe('后台任务「报告」已结束；自动汇报这一步没能完成，恢复原账号登录后可查看任务结果，也可以直接问我。');
    expect(message.metadata?.backgroundWakeFailed).toEqual({ taskId: 'task-n', reason: 'owner_missing', title: '报告' });
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
    expect(message.metadata?.backgroundWakeDeferred).toEqual({ taskId: 'task-n', outcome: 'completed', title: 't' });
    expect(h.emitted.at(-1)).toEqual({ sessionId: 'session-n', event: { type: 'message', data: message } });
  });

  it('persists and broadcasts one registered note when a resolving wake reports RUN_FAILED', async () => {
    orchestrator.sendMessage.mockImplementationOnce(async (_prompt, _attachments, options) => {
      options?.terminalErrorSink?.({ code: 'RUN_FAILED', message: '401 invalid api key' });
    });

    await createForegroundWake()(task, 'completed');

    expect(h.added).toHaveLength(1);
    const { message } = h.added[0];
    expect(message.metadata?.backgroundWakeFailed).toEqual({ taskId: 'task-n', reason: 'turn_error', title: '报告' });
    expect(h.emitted.filter((e) => e.event.type === 'error')).toEqual([]);
    expect(h.emitted).toEqual([{ sessionId: 'session-n', event: { type: 'message', data: message } }]);
  });

  it('carries task.shortName in metadata.backgroundWakeFailed.title across owner-retry exhaustion and backgroundWakeNoteRetry', async () => {
    vi.useFakeTimers();
    h.accessible = false;
    await createForegroundWake()(task, 'completed');
    for (let i = 1; i < BACKGROUND_WAKE_OWNER_RETRY_MAX_ATTEMPTS; i += 1) {
      await vi.advanceTimersByTimeAsync(BACKGROUND_WAKE_OWNER_RETRY_INTERVAL_MS);
    }

    const failedNotes = h.added.filter((entry) => entry.message.metadata?.backgroundWakeFailed);
    expect(failedNotes).toHaveLength(1);
    expect(failedNotes[0].message.content).toBe(formatBackgroundWakeFailureNote(task.shortName, 'owner_missing'));
    expect(failedNotes[0].message.metadata?.backgroundWakeFailed).toEqual({
      taskId: 'task-n',
      reason: 'owner_missing',
      title: '报告',
    });

    await recordBackgroundWakeFailureNoteWithOwnerRetry({
      sessionId: 'session-n',
      taskId: 'session-work-retry',
      shortName: 'Compare three note-taking apps',
      reason: 'wake_failed',
    });

    const retried = h.added.at(-1)!;
    expect(retried.message.content).toBe(
      '后台任务「Compare three note-taking apps」已结束；自动汇报没能完成。任务结果在后台任务面板里可以查看，也可以直接问我。',
    );
    expect(retried.message.metadata?.backgroundWakeFailed).toEqual({
      taskId: 'session-work-retry',
      reason: 'wake_failed',
      title: 'Compare three note-taking apps',
    });
  });
  it.each([
    ['owner_missing', 'wakeFailedOwnerMissing'],
    ['rate_limited', 'wakeFailedRateLimited'],
    ['max_iterations', 'wakeFailedMaxIterations'],
    ['wake_failed', 'wakeFailedGeneric'],
    ['turn_error', 'wakeFailedGeneric'],
  ] as const)('persists %s copy matching zh i18n and has the right login guidance in both languages', async (reason, key) => {
    await recordBackgroundWakeFailureNoteWithOwnerRetry({
      sessionId: task.sessionId, taskId: task.id, shortName: task.shortName, reason,
    });
    const note = h.added[0].message;
    expect(note.content).toBe(interpolate(backgroundPanelZh.backgroundPanel[key], { title: task.shortName }));
    expect(note.metadata?.backgroundWakeFailed?.reason).toBe(reason);
    const english = backgroundPanelEn.backgroundPanel[key];
    if (reason === 'owner_missing') {
      expect(note.content).toContain('恢复原账号登录');
      expect(english).toContain('sign back in');
    } else {
      expect(note.content).not.toMatch(/登录|sign back in|sign in/i);
      expect(english).not.toMatch(/登录|sign back in|sign in/i);
      expect(note.content).toContain('任务结果在后台任务面板里可以查看');
      expect(english).toContain('view the result in the background task panel');
    }
    if (reason === 'rate_limited') {
      expect(note.content).toContain('模型服务暂时限流');
      expect(english).toContain('model service is temporarily rate-limited');
    }
    if (reason === 'max_iterations') {
      expect(note.content).toContain('自动汇报用完了可用步骤');
      expect(english).toContain('automatic report ran out of steps');
    }
  });

  it.each([
    { source: 'sink', error: { status: 429, message: 'Request rejected' } },
    { source: 'throw', error: Object.assign(new Error('Request rejected'), { statusCode: 429 }) },
    { source: 'sink', error: { message: 'Rate limit exceeded' } },
    { source: 'throw', error: new Error('too many requests') },
  ])('classifies a $source rate limit from structured HTTP status or text through createForegroundWake', async ({ source, error }) => {
    orchestrator.sendMessage.mockImplementationOnce(async (_prompt, _attachments, options) => {
      if (source === 'throw') throw error;
      options?.terminalErrorSink?.(error);
    });
    await createForegroundWake()(task, 'completed');
    expect(h.added).toHaveLength(1);
    expect(h.added[0].message.metadata?.backgroundWakeFailed?.reason).toBe('rate_limited');
    expect(h.added[0].message.content).toBe('后台任务「报告」已结束；模型服务暂时限流，自动汇报没能完成。任务结果在后台任务面板里可以查看，稍后也可以直接问我。');
    expect(h.added[0].message.content).not.toMatch(/登录|sign back in|sign in/i);
  });

  it('keeps login guidance when sendMessage cannot access the owner session', async () => {
    orchestrator.sendMessage.mockRejectedValueOnce(new Error('Session session-n not found'));
    await createForegroundWake()(task, 'completed');
    expect(h.added[0].message.metadata?.backgroundWakeFailed?.reason).toBe('owner_missing');
    expect(h.added[0].message.content).toContain('恢复原账号登录');
  });

});
