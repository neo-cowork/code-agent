// 首次醒来会话在创建收口被标记（停车通知据此指回创建专家的对话）。真实 PermissionModeManager。
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UNSORTED_PROJECT_ID } from '../../../../src/shared/contract/project';

const sendMock = vi.fn();

const dbState = {
  sessions: [] as Array<Record<string, any>>,
};

const assignSessionProject = vi.fn((sessionId: string, projectId: string) => {
  const session = dbState.sessions.find((item) => item.id === sessionId);
  if (session) session.projectId = projectId;
});

const dbMock = {
  createSession: vi.fn((session: Record<string, any>) => {
    dbState.sessions.push({ ...session });
  }),
  getSession: vi.fn((id: string, options?: { userId?: string | null }) =>
    dbState.sessions.find((session) => {
      if (session.id !== id) return false;
      if (options?.userId === undefined) return true;
      return options.userId === null ? session.userId == null : session.userId === options.userId;
    }) ?? null
  ),
  updateSession: vi.fn((id: string, updates: Record<string, unknown>) => {
    const session = dbState.sessions.find((item) => item.id === id);
    if (session) Object.assign(session, updates);
  }),
  getProjectRepo: vi.fn(() => ({ assignSessionProject })),
  logAuditEvent: vi.fn(),
};

const ensureProjectForWorkspace = vi.fn(async (workspacePath: string | undefined) => ({
  id: workspacePath?.trim() ? `proj_${workspacePath.trim()}` : UNSORTED_PROJECT_ID,
}));

const projectsById = new Map<string, { id: string; status: string }>();
const getProjectDetail = vi.fn((projectId: string) => {
  const project = projectsById.get(projectId);
  if (!project) return undefined;
  return { project, sources: [], goals: [], roles: [], sessionIds: [] };
});

vi.mock('../../../../src/host/platform', () => ({
  AppWindow: {
    getAllWindows: () => [{ webContents: { send: sendMock } }],
  },
}));

vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => dbMock,
}));

vi.mock('../../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({ ensureProjectForWorkspace, getProjectDetail }),
}));

vi.mock('../../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({ clearSession: vi.fn() }),
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => ({ id: 'user-1' }) }),
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => false,
  getSupabase: () => null,
}));

async function makeManager() {
  const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
  return new SessionManager();
}

describe('SessionManager first-wake marker', () => {
  beforeEach(() => {
    dbState.sessions = [];
    vi.clearAllMocks();
  });

  it('marks only cron sessions whose origin trigger is first_wake', async () => {
    const { getPermissionModeManager } = await import('../../../../src/host/permissions/modes');
    const manager = await makeManager();
    const modelConfig = { provider: 'openai', model: 'gpt-5' };
    const firstWake = await manager.createSession({
      title: 'first', modelConfig, type: 'schedule',
      origin: { kind: 'cron', name: 'role-cadence', metadata: { roleId: 'r1', trigger: 'first_wake' } },
    });
    const plainCron = await manager.createSession({
      title: 'cron', modelConfig, type: 'schedule', origin: { kind: 'cron', id: 'job-1', name: 'job' },
    });
    const modes = getPermissionModeManager();
    expect(modes.isFirstWakeSession(firstWake.id)).toBe(true);
    expect(modes.isUnattendedSession(firstWake.id)).toBe(true);
    expect(modes.isFirstWakeSession(plainCron.id)).toBe(false);
  });
});
