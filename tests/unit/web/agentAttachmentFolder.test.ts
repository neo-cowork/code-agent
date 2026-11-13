import express from 'express';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Session } from '../../../src/shared/contract';
import { createAgentRouter } from '../../../src/web/routes/agent';
import { createCLIAgent } from '../../../src/cli/adapter';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { resolveDurableRunRollout } from '../../../src/host/app/durableRunRollout';
import { setDbAvailable } from '../../../src/web/helpers/sessionCache';
import { inMemorySessionsProjection, seedSessionMessagesFromPersisted, sessionMessagesProjection } from '../../../src/web/helpers/webSessionStore';

const mocks = vi.hoisted(() => ({
  language: 'zh',
  run: vi.fn(async () => undefined),
  db: {
    getDb: vi.fn(() => ({})), getSession: vi.fn(), getMessages: vi.fn(() => []),
    getRecentMessages: vi.fn(() => []), getTodos: vi.fn(() => []),
    listRecordedWorkingDirectories: vi.fn(() => []), getSessionForkLineage: vi.fn(() => null),
    addMessage: vi.fn(), updateMessage: vi.fn(), updateSession: vi.fn(), createSessionWithId: vi.fn(),
  },
}));
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
    getSettings: () => ({ ui: { language: mocks.language }, models: { providers: {} },
      permissions: { autoApprove: { read: true, write: false, execute: false, network: false } } }),
  }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({ getDatabase: () => mocks.db }));
vi.mock('../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({ getWorkspaceScope: () => undefined }),
}));
vi.mock('../../../src/host/telemetry', () => ({ getTelemetryCollector: () => ({ endSession: vi.fn() }) }));

let server: Server;
let baseUrl: string;
let home: string;
let session: Session;
let messages: Message[];
const registry = new RunRegistry();
const getMessages = vi.fn<(id: string, limit?: number) => Promise<Message[]>>();
const updateSession = vi.fn(async (_id: string, updates: Partial<Session>) => { Object.assign(session, updates); });
const attachment = { id: 'budget', name: 'sub/Q3-budget.xlsx', type: 'file', category: 'data', size: 1, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.language = 'zh';
  mocks.run.mockReset().mockResolvedValue(undefined);
  home = await mkdtemp(path.join(tmpdir(), 'route-attachment-folder-'));
  vi.stubEnv('CODE_AGENT_HOME', home);
  vi.stubEnv('CODE_AGENT_DATA_DIR', path.join(home, '.code-agent'));
  setDbAvailable(true);
  messages = [];
  getMessages.mockReset().mockImplementation(async (_id, limit) => limit === undefined ? messages : messages.slice(0, limit));
  session = { id: 'attachment-session', title: 'New Session', createdAt: 1, updatedAt: 1 } as Session;
  mocks.db.getSession.mockImplementation(() => session);
  const sm = {
    getSession: async () => ({ ...session, messages }),
    getMessages,
    updateSession,
    addMessageToSession: async (_id: string, message: Message) => { messages.push(message); },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createAgentRouter({
    runRegistry: registry, pendingLocalToolCalls: new Map(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tryGetSessionManager: async () => sm, tryGetCLISessionManager: async () => sm,
    getSupabaseForSession: async () => null,
    getDurableRunRollout: () => ({ policy: resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'legacy' }), ready: true }),
  }));
  server = await new Promise<Server>(resolve => { const next = app.listen(0, '127.0.0.1', () => resolve(next)); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  registry.clear();
  inMemorySessionsProjection.clear();
  sessionMessagesProjection.clear();
  setDbAvailable(false);
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

async function run(prompt: string, attachments?: unknown[]) {
  const response = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, prompt, attachments }),
  });
  const stream = await response.text();
  expect(response.status, stream).toBe(200);
  expect(stream).not.toContain('event: error');
}

const today = () => {
  const date = new Date();
  return `${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
};

describe('POST /api/run attachment-only folder naming', () => {
  it.each(['zh', 'en'])('plans the basename through the real agent route (%s)', async language => {
    mocks.language = language;
    await run('', [attachment]);
    const expected = path.join(home, 'Neo', `${language === 'en' ? 'Task' : '任务'}_${today()}_Q3-budget`);
    expect(createCLIAgent).toHaveBeenCalledWith(expect.objectContaining({ project: expected }));
    expect(session.workingDirectory).toBe(expected);
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it.each(['Appshot 会话', 'sub/Q3-budget.xlsx'])('retains the attachment folder on a later text turn with title %s', async title => {
    await run('', [attachment]);
    const planned = session.workingDirectory;
    expect(planned).toMatch(/_Q3-budget$/);
    session.title = title;
    // Preserve the actual first empty user message while sending a nonempty follow-up.
    expect(messages[0]).toMatchObject({ role: 'user', content: '', attachments: [attachment] });
    await run('Which department exceeded its budget?');
    expect(session.workingDirectory).toBe(planned);
    expect(vi.mocked(createCLIAgent).mock.calls.at(-1)?.[0]).toMatchObject({ project: planned });
  });

  it('preserves prompt naming when attachments are also present', async () => {
    await run('Summarize this budget, please', [attachment]);
    expect(session.workingDirectory).toMatch(/_Summarize this budget$/);
  });
});


describe('follow-up folder replanning reads', () => {
  let readsBeforeRun: unknown[][];
  function seedFollowUp(workingDirectory: string, title = 'Budget review') {
    readsBeforeRun = [];
    mocks.run.mockImplementationOnce(async () => { readsBeforeRun = getMessages.mock.calls.map(call => [...call]); });
    session.workingDirectory = workingDirectory;
    session.title = title;
    messages = [{ id: 'first-user', role: 'user', content: '', timestamp: 1,
      attachments: [{ ...attachment, type: 'file', category: 'data' }] }];
    // Ordinary inference history is already hydrated: isolate the extra preflight read.
    seedSessionMessagesFromPersisted(session.id, messages);
  }

  it.each(['chosen folder', 'default root', 'outside-root planned name', 'materialized', 'placeholder title', 'degraded title'])(
    'does not read messages when replan rejects a %s', async scenario => {
      let workingDirectory = path.join(home, 'Neo', `任务_${today()}_Q3-budget`);
      if (scenario === 'chosen folder') workingDirectory = path.join(home, 'chosen-budget');
      if (scenario === 'default root') workingDirectory = path.join(home, 'Neo');
      if (scenario === 'outside-root planned name') workingDirectory = path.join(home, `任务_${today()}_Q3-budget`);
      if (scenario === 'materialized') await mkdir(workingDirectory, { recursive: true });
      seedFollowUp(workingDirectory, scenario === 'placeholder title' ? 'New Session'
        : scenario === 'degraded title' ? 'Budget...' : 'Budget review');
      getMessages.mockRejectedValue(new Error('unnecessary preflight read'));
      await run('Which department exceeded its budget?');
      expect(readsBeforeRun).toEqual([]);
      expect(session.workingDirectory).toBe(workingDirectory);
      expect(mocks.run).toHaveBeenCalledOnce();
    },
  );

  it('limits the attachment guard lookup to the first persisted row', async () => {
    const workingDirectory = path.join(home, 'Neo', `任务_${today()}_Q3-budget`);
    seedFollowUp(workingDirectory, 'sub/Q3-budget.xlsx');
    await run('Which department exceeded its budget?');
    expect(readsBeforeRun).toEqual([[session.id, 1]]);
    expect(session.workingDirectory).toBe(workingDirectory);
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it('retains the planned attachment path and runs when the guard lookup fails', async () => {
    const workingDirectory = path.join(home, 'Neo', `任务_${today()}_Q3-budget`);
    seedFollowUp(workingDirectory, 'sub/Q3-budget.xlsx');
    getMessages.mockRejectedValue(new Error('first message read unavailable'));
    await run('Which department exceeded its budget?');
    expect(session.workingDirectory).toBe(workingDirectory);
    expect(updateSession).not.toHaveBeenCalledWith(session.id, expect.objectContaining({
      workingDirectory: expect.any(String),
    }));
    expect(mocks.run).toHaveBeenCalledOnce();
  });
});
