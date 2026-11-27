import express from 'express';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLISessionManager } from '../../../src/cli/session';
import { onRendererPush } from '../../../src/host/platform/windowBridge';
import { buildSessionTitle, deriveRuleSummaryTitle } from '../../../src/shared/sessionTitlePlaceholder';
import type { Message, Session } from '../../../src/shared/contract';
import { createAgentRouter } from '../../../src/web/routes/agent';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { resolveDurableRunRollout } from '../../../src/host/app/durableRunRollout';
import { setDbAvailable } from '../../../src/web/helpers/sessionCache';
import { inMemorySessionsProjection, sessionMessagesProjection } from '../../../src/web/helpers/webSessionStore';

const mocks = vi.hoisted(() => ({
  broadcastSSE: vi.fn<(channel: string, data: unknown) => void>(),
  run: vi.fn(async () => undefined),
  db: {
    getDb: vi.fn(() => ({})), getSession: vi.fn(), getMessages: vi.fn<() => Message[]>(),
    getRecentMessages: vi.fn<() => Message[]>(), getTodos: vi.fn(() => []),
    listRecordedWorkingDirectories: vi.fn(() => []), getSessionForkLineage: vi.fn(() => null),
    addMessage: vi.fn(), updateMessage: vi.fn(), updateSession: vi.fn(), createSessionWithId: vi.fn(),
  },
}));
vi.mock('../../../src/web/helpers/sse', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/web/helpers/sse')>(),
  broadcastSSE: mocks.broadcastSSE,
}));
vi.mock('../../../src/host/services/infra/sessionFolderName', () => ({
  initMemorySessionTitle: async () => null,
}));
vi.mock('../../../src/host/services/infra/sessionTitleCloudPush', () => ({
  pushSessionTitleToCloud: () => undefined,
}));
vi.mock('../../../src/host/telemetry/telemetryCollector', () => ({
  getTelemetryCollector: () => ({ updateSessionTitle: () => undefined }),
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
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
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

const SESSION_ID = 'session-title-single-frame';
const PLACEHOLDER = 'New Session';
const PROMPT = '帮我看看 workspace 里的服务合同.pdf，先查一下有没有可用的 PDF 工具，再总结要点';
const draftTitle = buildSessionTitle(PROMPT);
const summaryTitle = deriveRuleSummaryTitle(PROMPT, 'zh');

type Push = [channel: string, data: unknown];

let server: Server | undefined;
let home: string;
let stopListening: () => void;
const registry = new RunRegistry();
const rendererPushes: Push[] = [];

function titles(pushes: Push[]): string[] {
  return pushes.flatMap(([channel, data]) => {
    if (channel !== 'session:updated' || !data || typeof data !== 'object') return [];
    const event = data as { sessionId?: string; updates?: { title?: unknown } };
    return event.sessionId === SESSION_ID && typeof event.updates?.title === 'string'
      ? [event.updates.title]
      : [];
  });
}

function draftFrames(): string[] {
  return titles([...mocks.broadcastSSE.mock.calls, ...rendererPushes]).filter(title => title === draftTitle);
}

async function postRun(title: string, history: Message[] = []) {
  const infraSession: Session = { id: SESSION_ID, title, createdAt: 1, updatedAt: 1 };
  let storedSession = { ...infraSession };
  const messages = [...history];
  const titlesAtInsert: string[] = [];
  const db = {
    isInitialized: true,
    getSession: () => ({ ...storedSession }),
    getMessages: () => [...messages],
    getMessagesForLoad: () => [...messages],
    getTodos: () => [],
    updateSession: (_id: string, updates: Partial<Session>) => {
      storedSession = { ...storedSession, ...updates };
    },
    addMessage: (_id: string, message: Message) => {
      titlesAtInsert.push(storedSession.title);
      messages.push({ ...message });
    },
  };
  mocks.db.getSession.mockImplementation(db.getSession);
  mocks.db.getMessages.mockImplementation(db.getMessages);
  mocks.db.getRecentMessages.mockImplementation(db.getMessages);
  const manager = new CLISessionManager();
  Object.assign(manager, { _dbChecked: true, _db: db });

  // Infra keeps an independent snapshot even after the CLI write changes the row.
  const infra = {
    getSession: async () => ({ ...infraSession, messages: [...history] }),
    getMessages: async () => [...history],
    updateSession: vi.fn(),
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createAgentRouter({
    runRegistry: registry,
    pendingLocalToolCalls: new Map(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tryGetSessionManager: async () => infra,
    tryGetCLISessionManager: async () => manager,
    getSupabaseForSession: async () => null,
    getDurableRunRollout: () => ({
      policy: resolveDurableRunRollout({ CODE_AGENT_DURABLE_RUN_MODE: 'legacy' }),
      ready: true,
    }),
  }));
  server = await new Promise<Server>(resolve => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  const { port } = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${port}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, prompt: PROMPT }),
  });
  const stream = await response.text();
  expect(response.status, stream).toBe(200);
  expect(stream).not.toContain('event: error');
  expect(mocks.run).toHaveBeenCalledOnce();
  return { db, titlesAtInsert };
}

beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(path.join(tmpdir(), 'session-title-single-frame-'));
  vi.stubEnv('CODE_AGENT_HOME', home);
  vi.stubEnv('CODE_AGENT_DATA_DIR', path.join(home, '.code-agent'));
  setDbAvailable(true);
  rendererPushes.length = 0;
  stopListening = onRendererPush((channel, data) => rendererPushes.push([channel, data]));
});

afterEach(async () => {
  stopListening();
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

describe('POST /api/run provisional session title broadcasts', () => {
  it('emits the first-turn draft once and still emits the rule summary', async () => {
    expect(summaryTitle).not.toBe(draftTitle);
    const { db, titlesAtInsert } = await postRun(PLACEHOLDER);

    await vi.waitFor(() => expect(titles(rendererPushes)).toContain(summaryTitle));
    expect(draftFrames()).toHaveLength(1);
    expect(titles(mocks.broadcastSSE.mock.calls)).toEqual([draftTitle]);
    expect(titlesAtInsert).toEqual([draftTitle]);
    expect(db.getSession().title).toBe(summaryTitle);
  });

  it('preserves a named session without emitting the draft', async () => {
    const namedTitle = '合同审阅笔记';
    const { db, titlesAtInsert } = await postRun(namedTitle);

    expect(draftFrames()).toHaveLength(0);
    expect(titlesAtInsert).toEqual([namedTitle]);
    expect(db.getSession().title).toBe(namedTitle);
  });

  it('emits the draft from the CLI manager when the placeholder session has history', async () => {
    const { db } = await postRun(PLACEHOLDER, [
      { id: 'earlier-user-message', role: 'user', content: 'Read the contract', timestamp: 1 },
    ]);

    await vi.waitFor(() => expect(titles(rendererPushes)).toContain(draftTitle));
    expect(draftFrames()).toHaveLength(1);
    expect(titles(mocks.broadcastSSE.mock.calls)).toEqual([]);
    expect(db.getSession().title).toBe(draftTitle);
  });
});
