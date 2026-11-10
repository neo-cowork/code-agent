import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../src/host/services/core/database/migrations';
import { ProjectRepository } from '../../src/host/services/core/repositories/ProjectRepository';
import { getDatabase } from '../../src/host/services/core/databaseService';
import { getAuthService } from '../../src/host/services/auth/authService';
import { resetFolderTrustServiceForTest, evaluateFolderTrust } from '../../src/host/security/folderTrustService';
import { registerProjectHandlers } from '../../src/host/ipc/project.ipc';
import { createAgentRouter } from '../../src/web/routes/agent';
import { createDomainRouter } from '../../src/web/routes/domain';
import { handleServerError } from '../../src/web/middleware/serverErrors';
import { deleteSessionProjection } from '../../src/web/helpers/webSessionStore';
import { setDbAvailable } from '../../src/web/helpers/sessionCache';
import { RunRegistry } from '../../src/host/runtime/runRegistry';
import { workspacePathIdentity } from '../../src/host/runtime/workspaceScope';
import { createAgentLoop } from '../../src/cli/bootstrap';
import type { AgentEvent } from '../../src/shared/contract';

vi.mock('../../src/cli/adapter', () => ({ createCLIAgent: vi.fn(async () => ({ getConfig: () => ({
  modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash', apiKey: 'test-key' }, systemPrompt: '',
}) })) }));
vi.mock('../../src/cli/bootstrap', () => ({
  createRunToolExecutor: vi.fn(() => ({ execute: vi.fn() })),
  createAgentLoop: vi.fn((_config: unknown, emit: (event: AgentEvent) => void) => ({
    run: async () => emit({ type: 'message', data: { id: 'reply', role: 'assistant', content: '照片整理开始了。', timestamp: Date.now() } }),
    cancel: vi.fn(),
  })),
}));

const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
let server: Server, db: Database.Database, folder: string, root: string, url: string;
let previousDataDir: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  deleteSessionProjection('photos');
  root = mkdtempSync(join(tmpdir(), 'project-confirm-')); folder = join(root, 'photos'); mkdirSync(folder);
  previousDataDir = process.env.CODE_AGENT_DATA_DIR; process.env.CODE_AGENT_DATA_DIR = join(root, 'data');
  resetFolderTrustServiceForTest();
  db = new Database(':memory:'); applySchema(db, logger); applySessionsMigrations(db, logger);
  const now = Date.now();
  db.prepare('INSERT INTO projects (id,name,workspace_path,workspace_key,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('photos-project', 'Photos', folder, 'photos-key', 'active', now, now);
  db.prepare('INSERT INTO project_sources (id,project_id,path,canonical_path,role,access,trust_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('photos-source', 'photos-project', folder, folder, 'primary', 'read_write', 'trusted', now, now);
  const core = getDatabase();
  vi.spyOn(core, 'getProjectRepo').mockReturnValue(new ProjectRepository(db));
  const session = { id: 'photos', title: 'Photos', projectId: 'photos-project', workingDirectory: folder,
    modelProvider: 'xiaomi', model: 'mimo-v2.6-flash', createdAt: now, updatedAt: now };
  vi.spyOn(core, 'getSession').mockReturnValue(session as ReturnType<typeof core.getSession>);
  vi.spyOn(getAuthService(), 'getCurrentUser').mockReturnValue(null);
  setDbAvailable(false);
  const handlers = new Map();
  registerProjectHandlers({ handle: (channel, handler) => handlers.set(channel, handler) } as Parameters<typeof registerProjectHandlers>[0]);
  const app = express(); app.use(express.json());
  app.use('/api', createAgentRouter({ runRegistry: new RunRegistry(), pendingLocalToolCalls: new Map(), logger,
    tryGetSessionManager: async () => ({ getSession: async () => session }), tryGetCLISessionManager: async () => null,
    getSupabaseForSession: async () => null,
    getDurableRunRollout: () => ({ policy: { durableActivation: false }, ready: true }),
  } as Parameters<typeof createAgentRouter>[0]));
  app.use('/api', createDomainRouter({ handlers, logger })); app.use(handleServerError(logger));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP');
  url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  resetFolderTrustServiceForTest(); db.close(); vi.restoreAllMocks();
  if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR; else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});
const row = () => db.prepare('SELECT identity_ino,identity_birthtime_ns FROM project_sources').get();
const send = () => fetch(url + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'photos', clientMessageId: 'photo-message', prompt: '帮我把下载文件夹里的照片按日期改名' }) });
const confirm = (token: string, confirmed: boolean) => fetch(url + '/api/domain/project/confirmMissingSourceIdentity', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload: { sessionId: 'photos', token, confirmed } }),
});

describe('signed-out project identity confirmation through actual run and project routes', () => {
  it('does not write or run until explicit confirmation, then updates through the project service and permits the original send', async () => {
    const rejected = await send(); expect(rejected.status).toBe(422);
    const body = await rejected.json(); expect(body.code).toBe('PROJECT_SOURCE_IDENTITY_CONFIRM_REQUIRED');
    expect(row()).toEqual({ identity_ino: null, identity_birthtime_ns: null });
    expect(createAgentLoop).not.toHaveBeenCalled();
    const response = await confirm(body.recoveryToken, true);
    expect(await response.json()).toMatchObject({ success: true, data: { confirmed: true } });
    const identity = workspacePathIdentity(folder);
    expect(row()).toEqual({ identity_ino: identity.ino, identity_birthtime_ns: identity.birthtimeNs });
    expect(createAgentLoop).not.toHaveBeenCalled();
    const sent = await send(); expect(sent.status).toBe(200); expect(await sent.text()).toContain('照片整理开始了。');
    expect(createAgentLoop).toHaveBeenCalledTimes(1);
  });

  it('decline leaves identity NULL and no model run, even if sent to the confirmation endpoint', async () => {
    const body = await (await send()).json();
    expect(await (await confirm(body.recoveryToken, false)).json()).toMatchObject({ success: false });
    expect(row()).toEqual({ identity_ino: null, identity_birthtime_ns: null });
    expect((await evaluateFolderTrust(folder)).state).not.toBe('trusted');
    expect(createAgentLoop).not.toHaveBeenCalled();
  });

  it('a genuinely changed recorded identity receives no recovery button token and remains refused', async () => {
    const original = workspacePathIdentity(folder);
    db.prepare('UPDATE project_sources SET identity_dev=?,identity_ino=?,identity_birthtime_ns=?')
      .run(original.dev, original.ino, original.birthtimeNs);
    renameSync(folder, folder + '-old'); mkdirSync(folder);
    const response = await send(); expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'Project folder needs trust confirmation', code: 'PROJECT_SOURCE_TRUST' });
    expect(await (await confirm('not-issued', true)).json()).toMatchObject({ success: false });
    expect(row()).toEqual({ identity_ino: original.ino, identity_birthtime_ns: original.birthtimeNs });
    expect(createAgentLoop).not.toHaveBeenCalled();
  });

  it('a directory replaced after the prompt cannot be confirmed with the earlier token', async () => {
    const body = await (await send()).json(); renameSync(folder, folder + '-old'); mkdirSync(folder);
    expect(await (await confirm(body.recoveryToken, true)).json()).toMatchObject({ success: false });
    expect(row()).toEqual({ identity_ino: null, identity_birthtime_ns: null });
    expect((await evaluateFolderTrust(folder)).state).not.toBe('trusted');
    expect(createAgentLoop).not.toHaveBeenCalled();
  });
});
