// 无来源会话的定时任务（面板/API 新建）：运行会话的工作目录取任务自带的 metadata.workingDirectory。
// 优先级：常设刷新产物目录 > 任务文件夹 > 来源会话文件夹；都没有则 undefined（不取 UI 焦点会话）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobAction, CronJobDefinition } from '../../../src/shared/contract/cron';

const h = vi.hoisted(() => ({
  sessions: {} as Record<string, Record<string, unknown>>,
  focusedId: null as string | null,
  createSession: vi.fn(async (_options: Record<string, unknown>) => ({ id: 'cron-agent-session-1' })),
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => ({
    getCurrentSessionId: () => h.focusedId,
    getSession: async (id: string) => h.sessions[id] ?? null,
    createSession: h.createSession,
  }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => ({ models: { default: '', providers: {} } }),
    getApiKey: () => '',
  }),
}));

import { createCronAgentSession } from '../../../src/host/cron/cronAgentSession';

const action: CronJobAction = { type: 'agent', agentType: 'default', prompt: '总结笔记' };

function definition(metadata?: Record<string, unknown>): CronJobDefinition {
  return {
    id: 'job-1',
    name: '每周笔记',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '0 9 * * 1' } as CronJobDefinition['schedule'],
    action,
    runsOn: 'local',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...(metadata ? { metadata } : {}),
  };
}

function createdWorkingDirectory(): unknown {
  return (h.createSession.mock.calls[0]?.[0] as { workingDirectory?: unknown }).workingDirectory;
}

describe('createCronAgentSession working folder', () => {
  beforeEach(() => {
    h.createSession.mockClear();
    h.sessions = {};
    h.focusedId = null;
  });

  it('uses metadata.workingDirectory when the task has no source session', async () => {
    await createCronAgentSession(definition({ workingDirectory: '/Users/me/notes' }), action);
    expect(createdWorkingDirectory()).toBe('/Users/me/notes');
  });

  it('leaves the folder unset without a task folder or source session, even if a chat is focused', async () => {
    h.sessions.focus = { id: 'focus', workingDirectory: '/Users/me/focused', modelConfig: {} };
    h.focusedId = 'focus';
    await createCronAgentSession(definition(), action);
    expect(createdWorkingDirectory()).toBeUndefined();
  });

  it('ignores a relative task folder', async () => {
    await createCronAgentSession(definition({ workingDirectory: 'notes' }), action);
    expect(createdWorkingDirectory()).toBeUndefined();
  });

  it('falls back to the source session folder when the task has no folder', async () => {
    h.sessions.src = { id: 'src', workingDirectory: '/Users/me/source', modelConfig: {} };
    await createCronAgentSession(definition({ sourceSessionId: 'src' }), action);
    expect(createdWorkingDirectory()).toBe('/Users/me/source');
  });

  it('prefers the task folder over the source session folder', async () => {
    h.sessions.src = { id: 'src', workingDirectory: '/Users/me/source', modelConfig: {} };
    await createCronAgentSession(definition({ sourceSessionId: 'src', workingDirectory: '/Users/me/notes' }), action);
    expect(createdWorkingDirectory()).toBe('/Users/me/notes');
  });

  it('keeps the standing-refresh artifact folder ahead of the task folder', async () => {
    await createCronAgentSession(definition({
      workingDirectory: '/Users/me/notes',
      artifactRefresh: { path: '/Users/me/reports/status.md', instruction: 'refresh', cadence: 'hourly' },
    }), action);
    expect(createdWorkingDirectory()).toBe('/Users/me/reports');
  });
});
