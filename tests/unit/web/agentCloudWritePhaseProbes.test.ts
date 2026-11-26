import express from 'express';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Session } from '../../../src/shared/contract';
import { createAgentRouter } from '../../../src/web/routes/agent';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { resolveDurableRunRollout } from '../../../src/host/app/durableRunRollout';
import { setDbAvailable } from '../../../src/web/helpers/sessionCache';
import { inMemorySessionsProjection, sessionMessagesProjection } from '../../../src/web/helpers/webSessionStore';

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  run: vi.fn(async () => undefined),
  db: {
    getDb: vi.fn(() => ({})), getSession: vi.fn(), getMessages: vi.fn(() => []),
    getRecentMessages: vi.fn(() => []), getTodos: vi.fn(() => []),
    listRecordedWorkingDirectories: vi.fn(() => []), getSessionForkLineage: vi.fn(() => null),
    addMessage: vi.fn(), updateMessage: vi.fn(), updateSession: vi.fn(), createSessionWithId: vi.fn(),
  },
}));
vi.mock('../../../src/host/services/infra/logger', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/host/services/infra/logger')>(),
  createLogger: () => ({
    debug: vi.fn(), info: mocks.info, warn: vi.fn(), error: vi.fn(), setLevel: vi.fn(), dispose: vi.fn(),
  }),
}));
vi.mock('../../../src/host/model/quickModel', () => ({ quickTask: vi.fn(), isQuickModelAvailable: () => false }));
vi.mock('../../../src/cli/adapter', () => ({
  createCLIAgent: vi.fn(async () => ({ getConfig: () => ({
    modelConfig: { provider: 'xiaomi', model: 'test-model', apiKey: 'mock-key' }, systemPrompt: '',
  }) })),
}));
vi.mock('../../../src/cli/bootstrap', () => ({
  createAgentLoop: () => ({ run: mocks.run, cancel: vi.fn(), steer: vi.fn() }),
  createRunToolExecutor: () => ({ execute: vi.fn() }), getToolExecutor: () => undefined,
}));
vi.mock('../../../src/host/services/core/configService', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/host/services/core/configService')>(),
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(), isDevModeAutoApproveEnabled: () => false,
    getSettings: () => ({ ui: { language: 'zh' }, models: { providers: {} },
      permissions: { autoApprove: { read: true, write: false, execute: false, network: false } } }),
  }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: () => mocks.db }));
vi.mock('../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({ getWorkspaceScope: () => undefined }),
}));
vi.mock('../../../src/host/telemetry', () => ({ getTelemetryCollector: () => ({ endSession: vi.fn() }) }));

let server: Server | undefined;
let baseUrl = '';
let home = '';
let session: Session;
let messages: Message[];
const registry = new RunRegistry();

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function fakeSupabase() {
  const sessionsTable = {
    upsert: vi.fn(async () => { await delay(10); return { error: null }; }),
    select: vi.fn(() => ({ eq: vi.fn(async () => { await delay(10); return { data: [{ title: '云同步首轮' }], error: null }; }) })),
    update: vi.fn(() => ({ eq: vi.fn(async () => { await delay(10); return { error: null }; }) })),
  };
  const messagesTable = {
    insert: vi.fn(async () => { await delay(10); return { error: null }; }),
  };
  return { from: vi.fn((table: string) => table === 'sessions' ? sessionsTable : messagesTable) };
}

async function startApi(getSupabaseForSession: () => Promise<unknown>) {
  const sm = {
    getSession: async () => ({ ...session, messages }),
    getMessages: vi.fn(async () => messages),
    updateSession: vi.fn(async (_id: string, updates: Partial<Session>) => { Object.assign(session, updates); }),
    addMessageToSession: async (_id: string, message: Message) => { messages.push(message); },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createAgentRouter({
    runRegistry: registry, pendingLocalToolCalls: new Map(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tryGetSessionManager: async () => sm, tryGetCLISessionManager: async () => sm,
    getSupabaseForSession: getSupabaseForSession as never,
    getDurableRunRollout: () => ({ policy: resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'legacy' }), ready: true }),
  }));
  server = await new Promise<Server>(resolve => { const next = app.listen(0, '127.0.0.1', () => resolve(next)); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function postRun() {
  const response = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, prompt: '云同步首轮' }),
  });
  const stream = await response.text();
  expect(response.status, stream).toBe(200);
  expect(stream).not.toContain('event: error');
}

function phaseCalls() {
  return mocks.info.mock.calls
    .filter(([message]) => message === 'First model request phase')
    .map(([, payload]) => payload as { phase: string; previousPhase?: string; previousPhaseElapsedMs?: number })
    .filter(entry => entry.phase.startsWith('web_cloud_'));
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.run.mockReset().mockResolvedValue(undefined);
  home = await mkdtemp(path.join(tmpdir(), 'route-cloud-probes-'));
  vi.stubEnv('CODE_AGENT_HOME', home);
  vi.stubEnv('CODE_AGENT_DATA_DIR', path.join(home, '.code-agent'));
  setDbAvailable(true);
  messages = [];
  session = { id: 'cloud-probe-session', title: 'New Session', createdAt: 1, updatedAt: 1 } as Session;
  mocks.db.getSession.mockImplementation(() => session);
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve, reject) => server!.close(err => err ? reject(err) : resolve()));
  server = undefined;
  registry.clear();
  inMemorySessionsProjection.clear();
  sessionMessagesProjection.clear();
  setDbAvailable(false);
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('POST /api/run first-turn folderless cloud write phase probes', () => {
  it('signed-in run logs session-row, insert and done phases in order with numeric previous-phase timings', async () => {
    await startApi(async () => ({ supabase: fakeSupabase(), userId: 'user-probe' }));
    await postRun();

    expect(mocks.run).toHaveBeenCalledOnce();
    const cloud = phaseCalls();
    expect(cloud.map(entry => entry.phase)).toEqual([
      'web_cloud_session_row_sync',
      'web_cloud_user_message_insert',
      'web_cloud_user_message_done',
    ]);
    expect(cloud.map(entry => entry.previousPhase)).toEqual([
      'web_user_message_persist',
      'web_cloud_session_row_sync',
      'web_cloud_user_message_insert',
    ]);
    for (const entry of cloud) {
      expect(entry.previousPhaseElapsedMs, `phase ${entry.phase}`).toEqual(expect.any(Number));
    }
    // 每个标记必须真的跨住它要计时的那次 await（假 supabase 每步 ~10ms）：
    // 挪到同一侧时相位顺序不变、但被测段塌缩到 ~0ms，这两个下限会红。
    expect(cloud[1].previousPhaseElapsedMs).toBeGreaterThanOrEqual(25);
    expect(cloud[2].previousPhaseElapsedMs).toBeGreaterThanOrEqual(5);
  });

  it('signed-out run logs none of the three cloud write phases', async () => {
    await startApi(async () => null);
    await postRun();

    expect(mocks.run).toHaveBeenCalledOnce();
    expect(phaseCalls()).toEqual([]);
  });
});
