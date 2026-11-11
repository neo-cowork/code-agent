import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { resolveDurableRunRollout } from '../../src/host/app/durableRunRollout';
import type { Server } from 'node:http';
import { createAgentRouter } from '../../src/web/routes/agent';
import { observeServerErrors, handleServerError } from '../../src/web/middleware/serverErrors';
import { ProjectSourceTrustError } from '../../src/host/services/project/projectSourceTrustError';
import { RunRegistry } from '../../src/host/runtime/runRegistry';
import { setDbAvailable } from '../../src/web/helpers/sessionCache';
import { getAuthService } from '../../src/host/services/auth/authService';
import { getDatabase } from '../../src/host/services/core/databaseService';
import type { AgentEvent } from '../../src/shared/contract';
import { createAgentLoop } from '../../src/cli/bootstrap';
import { getProjectService } from '../../src/host/services/project/projectService';
import { mkdtempSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../src/host/services/core/database/migrations';
import { ProjectRepository } from '../../src/host/services/core/repositories/ProjectRepository';
import { resetFolderTrustServiceForTest, evaluateFolderTrust } from '../../src/host/security/folderTrustService';
import { registerProjectHandlers } from '../../src/host/ipc/project.ipc';
import { createDomainRouter } from '../../src/web/routes/domain';
import { deleteSessionProjection } from '../../src/web/helpers/webSessionStore';
import { workspacePathIdentity } from '../../src/host/runtime/workspaceScope';
import { createLogger } from '../../src/host/services/infra/logger';
import type { HandlerFn } from '../../src/host/platform/ipcTypes';
import type { StoredSession } from '../../src/host/protocol/types/repositories';

const mockedReply = vi.hoisted(() => ({ value: '' }));
vi.mock('../../src/cli/adapter', () => ({
  createCLIAgent: vi.fn(async () => ({ getConfig: () => ({
    modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash', apiKey: 'test-configured-key', baseUrl: 'https://model.example/v1' },
    systemPrompt: '',
  }) })),
}));
vi.mock('../../src/cli/bootstrap', () => ({
  createRunToolExecutor: vi.fn(() => ({ execute: vi.fn() })),
  createAgentLoop: vi.fn((_config: unknown, emit: (event: AgentEvent) => void) => ({
    run: async () => { emit({ type: 'message', data: {
      id: 'assistant-reply', role: 'assistant', content: mockedReply.value, timestamp: Date.now(),
    } }); },
    cancel: vi.fn(),
  })),
}));

describe('real /api/run router error boundary', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let server: Server;
  let url: string;

  beforeEach(async () => {
    mockedReply.value = '请确认按拍摄日期还是修改日期命名。';
    vi.clearAllMocks();
    setDbAvailable(false);
    const app = express();
    app.use(observeServerErrors(logger));
    app.use(express.json());
    app.use('/api', createAgentRouter({
      runRegistry: new RunRegistry(), pendingLocalToolCalls: new Map(), logger,
      tryGetSessionManager: async () => ({ getSession: async () => ({
        modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' }, createdAt: 1, updatedAt: 1,
        id: 'photos', title: '照片按日期改名', projectId: 'photo-project', workingDirectory: '/workspace/photos',
      }) }),
      tryGetCLISessionManager: async () => null,
      getDurableRunRollout: () => ({ policy: resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'legacy' }), ready: true }),
      getSupabaseForSession: async () => null,
    }));
    app.get('/explicit-failure', (_req, res) => { res.status(503).json({ error: 'storage unavailable' }); });
    app.use(handleServerError(logger));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    url = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  async function send() {
    return fetch(`${url}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'photos', prompt: '帮我把下载文件夹里的照片按日期改名' }) });
  }

    it.each([false, true])('configured-model send retains assistant SSE with signedIn=%s', async signedIn => {
      vi.spyOn(getAuthService(), 'getCurrentUser').mockReturnValue(signedIn ? { id: 'test-user', email: 'user@example.invalid' } : null);
      vi.spyOn(getProjectService(), 'getWorkspaceScope').mockReturnValue(undefined);
      vi.spyOn(getDatabase(), 'getSession').mockReturnValue(null);
      const response = await send();
      expect(response.status).toBe(200);
      const sse = await response.text();
      expect(sse).toContain('event: message');
      expect(sse).toContain('请确认按拍摄日期还是修改日期命名。');
      expect(sse).toContain('event: agent_complete');
      expect(createAgentLoop).toHaveBeenCalledWith(expect.objectContaining({
        modelConfig: expect.objectContaining({ provider: 'xiaomi', model: 'mimo-v2.6-flash', baseUrl: 'https://model.example/v1' }),
      }), expect.any(Function), expect.any(Array), 'photos', undefined, expect.anything(), expect.anything(), undefined);
    });

    it('logs the throwing preflight function reason and returns safe JSON for a 500', async () => {
      vi.spyOn(getAuthService(), 'getCurrentUser').mockReturnValue(null);
      vi.spyOn(getProjectService(), 'getWorkspaceScope').mockImplementation(() => { throw new Error('preflight storage unavailable'); });
      const response = await send();
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ error: 'Local server request failed', code: 'INTERNAL_SERVER_ERROR' });
      expect(logger.error).toHaveBeenCalledWith('Local server request failed', {
        method: 'POST', route: '/api/run', status: 500, reason: 'preflight storage unavailable',
      });
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('keeps missing directory trust denied and returns an actionable code instead of HTML', async () => {
      vi.spyOn(getAuthService(), 'getCurrentUser').mockReturnValue(null);
      const scope = vi.spyOn(getProjectService(), 'getWorkspaceScope').mockImplementation(() => {
        throw new ProjectSourceTrustError('identity_changed', '/workspace/photos');
      });
      const response = await send();
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: 'Project folder needs trust confirmation', code: 'PROJECT_SOURCE_TRUST' });
      expect(scope).toHaveBeenCalledWith('photo-project');
    });

    it('also logs explicit 5xx responses with method, route and reason', async () => {
      const response = await fetch(`${url}/explicit-failure`);
      expect(response.status).toBe(503);
      await response.text();
      await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith('Local server request failed', {
        method: 'GET', route: '/explicit-failure', status: 503, reason: 'storage unavailable',
      }));
    });
});

describe('signed-out project identity confirmation through actual run and project routes', () => {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let server: Server, db: Database.Database, folder: string, root: string, url: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    mockedReply.value = '照片整理开始了。';
    vi.clearAllMocks();
    deleteSessionProjection('photos');
    root = mkdtempSync(join(tmpdir(), 'project-confirm-')); folder = join(root, 'photos'); mkdirSync(folder);
    previousDataDir = process.env.CODE_AGENT_DATA_DIR; process.env.CODE_AGENT_DATA_DIR = join(root, 'data');
    resetFolderTrustServiceForTest();
    db = new Database(':memory:');
    const schemaLogger = createLogger('ProjectIdentityRecoveryTest');
    applySchema(db, schemaLogger); applySessionsMigrations(db, schemaLogger);
    const now = Date.now();
    db.prepare('INSERT INTO projects (id,name,workspace_path,workspace_key,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run('photos-project', 'Photos', folder, 'photos-key', 'active', now, now);
    db.prepare('INSERT INTO project_sources (id,project_id,path,canonical_path,role,access,trust_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('photos-source', 'photos-project', folder, folder, 'primary', 'read_write', 'trusted', now, now);
    const core = getDatabase();
    vi.spyOn(core, 'getProjectRepo').mockReturnValue(new ProjectRepository(db));
    const session: StoredSession = { id: 'photos', title: 'Photos', projectId: 'photos-project', workingDirectory: folder,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' }, messageCount: 0, createdAt: now, updatedAt: now };
    vi.spyOn(core, 'getSession').mockReturnValue(session);
    vi.spyOn(getAuthService(), 'getCurrentUser').mockReturnValue(null);
    setDbAvailable(false);
    const handlers = new Map<string, HandlerFn>();
    registerProjectHandlers({
      handle: (channel, handler) => { handlers.set(channel, handler); },
      on: vi.fn(),
      removeHandler: channel => { handlers.delete(channel); },
      removeAllListeners: vi.fn(),
    });
    const app = express(); app.use(express.json());
    app.use('/api', createAgentRouter({ runRegistry: new RunRegistry(), pendingLocalToolCalls: new Map(), logger,
      tryGetSessionManager: async () => ({ getSession: async () => session }), tryGetCLISessionManager: async () => null,
      getSupabaseForSession: async () => null,
      getDurableRunRollout: () => ({ policy: resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'legacy' }), ready: true }),
    }));
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

