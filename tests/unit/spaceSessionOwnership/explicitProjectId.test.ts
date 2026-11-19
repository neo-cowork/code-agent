// 协作空间首页 composer 发起的会话必须归属该空间：显式 projectId 一路从
// SessionLifecycleAppService 到 sessionManager，优先于目录反查（真 sqlite + 真 ProjectService/SessionManager）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { ProjectRepository } from '../../../src/host/services/core/repositories/ProjectRepository';
import { createLogger } from '../../../src/host/services/infra/logger';
import { UNSORTED_PROJECT_ID } from '../../../src/shared/contract/project';

const state = vi.hoisted(() => ({ db: null as unknown, warn: [] as string[] }));

vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const real = actual.createLogger(name);
      return new Proxy(real, {
        get: (target, prop, receiver) =>
          prop === 'warn'
            ? (...args: unknown[]) => { state.warn.push(String(args[0])); }
            : Reflect.get(target, prop, receiver),
      });
    },
  };
});

vi.mock('../../../src/host/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  AppWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../src/host/services/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: () => state.db,
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: () => state.db }));
vi.mock('../../../src/host/services/roleAssets/roleAssetService', () => ({
  linkProjectIdToMeta: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/host/services/permissions/modes', () => ({
  getPermissionModeManager: () => ({ initSessionMode: vi.fn(), markUnattendedSession: vi.fn() }),
}));
vi.mock('../../../src/host/services/infra/toolCache', () => ({ getToolCache: () => ({ clearSession: vi.fn(), setSessionId: vi.fn() }) }));
vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));
vi.mock('../../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => false,
  getSupabase: () => null,
}));
vi.mock('../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({ provider: 'openai', model: 'gpt-5' }),
}));

import { SessionLifecycleAppService } from '../../../src/host/app/sessionLifecycleAppService';
import { getSessionManager } from '../../../src/host/services/infra/sessionManager';
import { getProjectService } from '../../../src/host/services/project/projectService';

const logger = createLogger('explicitProjectId.test');

describe('explicit projectId on session create (space composer without a folder)', () => {
  let sqlite: InstanceType<typeof Database>;
  let service: SessionLifecycleAppService;
  let projectRepo: ProjectRepository;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applySchema(sqlite, logger);
    applySessionsMigrations(sqlite, logger);
    const sessions = new SessionRepository(sqlite);
    projectRepo = new ProjectRepository(sqlite);
    state.db = {
      createSession: (s: never) => sessions.createSession(s),
      getSession: (id: string, o?: never) => sessions.getSession(id, o),
      updateSession: (id: string, u: never) => (sessions as unknown as { updateSession: (a: string, b: unknown) => void }).updateSession(id, u),
      getProjectRepo: () => projectRepo,
      logAuditEvent: vi.fn(),
    };
    service = new SessionLifecycleAppService({
      getTaskManager: () => ({
        cleanup: vi.fn(),
        setCurrentSessionId: vi.fn(),
        getOrCreateCurrentOrchestrator: vi.fn(() => null),
      }) as never,
      getConfigService: () => ({}) as never,
      getCurrentSessionId: () => null,
      setCurrentSessionId: vi.fn(),
      getWorkingDirectory: () => undefined,
    });
    state.warn.length = 0;
  });

  afterEach(() => sqlite.close());

  const rowProjectId = (id: string) =>
    (sqlite.prepare('SELECT project_id FROM sessions WHERE id = ?').get(id) as { project_id: string }).project_id;

  it('name-only space + explicit id: session lands in the space, not in quick chats', async () => {
    const space = await getProjectService().createSpace({ name: '周计划空间' }, 1000);
    expect(space.workspacePath ?? null).toBeNull();

    const session = await service.createSession({ title: '写一篇短文', workingDirectory: undefined, projectId: space.id });

    expect(session.projectId).toBe(space.id);
    expect(rowProjectId(session.id)).toBe(space.id);
  });

  it('without projectId the same folderless create still goes to quick chats', async () => {
    const session = await service.createSession({ title: '随手问' });
    expect(rowProjectId(session.id)).toBe(UNSORTED_PROJECT_ID);
  });

  it('unknown id falls back to directory lookup and warns with a distinguishable reason', async () => {
    const session = await service.createSession({ title: 'x', projectId: 'proj_does_not_exist' });
    expect(rowProjectId(session.id)).toBe(UNSORTED_PROJECT_ID);
    expect(state.warn.some((line) => line.includes('explicit projectId not found'))).toBe(true);
  });

  it('archived id falls back and warns with the archived reason', async () => {
    const space = await getProjectService().createSpace({ name: '已归档空间' }, 1000);
    projectRepo.setProjectStatus(space.id, 'archived', 2000, 2000);
    const session = await service.createSession({ title: 'x', projectId: space.id });
    expect(rowProjectId(session.id)).toBe(UNSORTED_PROJECT_ID);
    expect(state.warn.some((line) => line.includes('explicit projectId is archived'))).toBe(true);
  });

  it('explicit id survives a later working-directory write', async () => {
    const space = await getProjectService().createSpace({ name: '周计划空间' }, 1000);
    const session = await service.createSession({ title: 'x', projectId: space.id });
    await getSessionManager().updateSession(session.id, { workingDirectory: '/tmp/neo-explicit-later' });
    expect(rowProjectId(session.id)).toBe(space.id);
  });
});
