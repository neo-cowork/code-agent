import express from 'express';
import { resolveDurableRunRollout } from '../../src/host/app/durableRunRollout';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      id: 'assistant-photo', role: 'assistant', content: '请确认按拍摄日期还是修改日期命名。', timestamp: Date.now(),
    } }); },
    cancel: vi.fn(),
  })),
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let server: Server;
let url: string;

beforeEach(async () => {
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

describe('real /api/run router error boundary', () => {
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
