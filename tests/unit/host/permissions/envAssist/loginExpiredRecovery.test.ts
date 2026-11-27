// Evidence class: hermetic-protocol (SQLite durable kernel + production ToolExecutionEngine / ProtocolToolResolver / MCPClient / feishuMinutesSearch / envAssist.ipc / envResumeWaiter / continueParkedDurableRun; local fake OAuth HTTP MCP server + fake lark-cli driver).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type { AgentEvent, Message } from '../../../../../src/shared/contract';
import type { EnvAssistNotice } from '../../../../../src/shared/contract/envAssist';
import type { TaskManager } from '../../../../../src/host/task';
import type { Router } from 'express';

const mocks = vi.hoisted(() => {
  const storageValues = new Map<string, string>();
  const cliState = {
    connected: false,
    statusCalls: [] as boolean[],
    connectCalls: 0,
    executeCalls: 0,
    connectSucceeds: true,
    silentStatusRecovers: false,
  };
  return {
    storage: {
      values: storageValues,
      get: (key: string) => storageValues.get(key),
      set: (key: string, value: string) => { storageValues.set(key, value); },
      delete: (key: string) => { storageValues.delete(key); },
      getDeviceId: () => 'test-device-id',
      getDeviceName: () => 'test-device',
      has: (key: string) => storageValues.has(key),
      getApiKey: () => undefined,
      setApiKey: () => undefined,
      deleteApiKey: () => undefined,
    },
    shell: {
      opened: [] as string[],
      autoAuthorize: true,
    },
    messages: [] as Message[],
    events: [] as Array<{ sessionId: string; event: AgentEvent }>,
    db: {} as Record<string, unknown>,
    warn: vi.fn(),
    info: vi.fn(),
    cli: cliState,
  };
});

vi.mock('../../../../../src/host/services/core/secureStorage', () => ({ getSecureStorage: () => mocks.storage }));
vi.mock('../../../../../src/host/mcp/mcpOAuthConsent', () => ({
  requestMcpOAuthConsent: vi.fn(async () => ({ granted: true })),
}));
vi.mock('../../../../../src/host/platform/nativeShell', () => ({
  openExternal: vi.fn(async (url: string) => {
    mocks.shell.opened.push(url);
    if (mocks.shell.autoAuthorize) {
      void fetch(url).catch(() => {});
    }
  }),
}));
vi.mock('../../../../../src/host/services/core/databaseService', () => ({ getDatabase: () => mocks.db }));
vi.mock('../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async (sessionId: string) => [
      ...((mocks.db.getMessages as ((id: string) => Message[]) | undefined)?.(sessionId) ?? []),
      ...mocks.messages.map((m) => structuredClone(m)),
    ],
    addMessageToSession: async (_s: string, m: Message) => {
      const i = mocks.messages.findIndex((x) => x.id === m.id);
      if (i >= 0) mocks.messages[i] = m; else mocks.messages.push(m);
    },
  }),
}));
vi.mock('../../../../../src/host/services/agentEngine/agentEngineEventSink', () => ({
  emitExternalAgentEvent: (sessionId: string, event: AgentEvent) => { mocks.events.push({ sessionId, event }); },
}));
vi.mock('../../../../../src/host/permissions/envAssist/settingsPane', () => ({
  canOpenEnvSettings: () => false,
  openEnvSettings: vi.fn(async () => false),
}));
vi.mock('../../../../../src/host/permissions/envAssist/shellBridge/client', () => ({
  canRequestEnvGrant: async () => false,
  resolveShellBridgeClientFromEnv: () => null,
}));
vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../../src/host/services/infra/logger')>(),
  createLogger: () => ({ debug: vi.fn(), info: mocks.info, error: vi.fn(), warn: mocks.warn }),
}));
vi.mock('../../../../../src/host/connectors/feishu/larkCli', () => ({
  createLarkCliDriver: () => ({
    status: vi.fn(async (forceRefresh = false) => {
      mocks.cli.statusCalls.push(forceRefresh);
      if (forceRefresh && mocks.cli.silentStatusRecovers) {
        mocks.cli.connected = true;
      }
      return mocks.cli.connected
        ? { connected: true, identity: 'user' }
        : { connected: false, identity: 'none', lostReason: 'cli_not_logged_in' as const };
    }),
    connect: vi.fn(async () => {
      mocks.cli.connectCalls++;
      if (!mocks.cli.connectSucceeds) throw new Error('Feishu login cancelled');
      mocks.cli.connected = true;
      return { alreadyConnected: false, status: { connected: true, identity: 'user' } };
    }),
    execute: vi.fn(async () => {
      mocks.cli.executeCalls++;
      if (!mocks.cli.connected) {
        throw Object.assign(new Error('lark-cli auth failed'), { stderr: 'no logged-in user; please run lark-cli auth login' });
      }
      return {
        stdout: JSON.stringify({
          data: {
            items: [{ token: 'min123', display_info: 'Weekly Sync\nOwner: Alice', meta_data: { description: 'Today 10:00', app_link: 'https://feishu.cn/minutes/min123' } }],
            has_more: false,
          },
        }),
        stderr: '',
        exitCode: 0,
      };
    }),
  }),
}));

import { applySchema } from '../../../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../../../src/host/services/core/database/migrations';
import { applyIndexes } from '../../../../../src/host/services/core/database/indexes';
import { SessionRepository } from '../../../../../src/host/services/core/repositories/SessionRepository';
import { ToolExecutionEventRepository } from '../../../../../src/host/services/core/repositories/ToolExecutionEventRepository';
import { DurableRunRepository } from '../../../../../src/host/services/core/repositories/DurableRunRepository';
import { getApplicationRunRegistry } from '../../../../../src/host/app/applicationRunRegistry';
import { DurableRunKernel } from '../../../../../src/host/runtime/durableRunKernel';
import { createApplicationNativeRecoveryPorts } from '../../../../../src/host/app/nativeRecoveryHost';
import { continueParkedDurableRun } from '../../../../../src/host/app/durableRunContinuation';
import { finalizeOrParkDurableRun } from '../../../../../src/host/agent/orchestrator/durableRunTerminal';
import { getProtocolRegistry } from '../../../../../src/host/tools/protocolRegistry';
import { getToolDefinitionWithCloudMeta } from '../../../../../src/host/tools/dispatch/toolDefinitions';
import { setToolLedgerSink } from '../../../../../src/host/tools/toolLedgerSink';
import { ToolExecutor } from '../../../../../src/host/tools/toolExecutor';
import { resetToolResolver } from '../../../../../src/host/tools/dispatch/toolResolver';
import { getMCPClient } from '../../../../../src/host/mcp/mcpClient';
import { registerEnvAssistHandlers, envResumeProbeFactory } from '../../../../../src/host/ipc/envAssist.ipc';
import { registerAgentContinueRoute } from '../../../../../src/web/routes/registerAgentContinueRoute';
import { registerEnvResumeContinuer, armEnvResumeOnPark, clearEnvResumeWaiter } from '../../../../../src/host/runtime/envResumeWaiter';
import { ENV_RESUME_POLL_INTERVAL_MS, ENV_RESUME_TIMEOUT_MS } from '../../../../../src/shared/constants/envResume';
import { OAUTH_FLOW_TIMEOUT_MS } from '../../../../../src/host/connectors/oauth/oauthCoordinator';
import { ipcHost, type HandlerFn } from '../../../../../src/host/platform';
import { feishuMinutesSearchSchema } from '../../../../../src/host/tools/modules/connectors/feishuMinutesSearch.schema';
import { feishuMinutesSearchModule } from '../../../../../src/host/tools/modules/connectors/feishuMinutes';
import { makeEngine } from '../../runtime/envResumeContext';
import { createLogger } from '../../../../../src/host/services/infra/logger';

interface FakeNotesServer {
  url: string;
  requests: string[];
  issueRefreshToken: boolean;
  expireAccessTokens(): void;
  revokeRefreshTokens(): void;
  reset(): void;
  close(): Promise<void>;
}

async function startFakeNotesServer(): Promise<FakeNotesServer> {
  const codes = new Map<string, string>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const requests: string[] = [];
  let issueRefreshToken = true;
  let tokenSeq = 0;
  let base = '';

  const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base || 'http://127.0.0.1');
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/register') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      requests.push('POST /register');
      return json(res, 201, { ...body, client_id: 'fake-notes-client' });
    }
    if (url.pathname === '/authorize') {
      requests.push('GET /authorize');
      const code = `code-${++tokenSeq}`;
      codes.set(code, url.searchParams.get('scope') ?? 'read');
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await readBody(req));
      const grantType = form.get('grant_type');
      if (grantType === 'refresh_token') {
        const rt = form.get('refresh_token') ?? '';
        requests.push(`POST /token grant_type=refresh_token valid=${refreshTokens.has(rt)}`);
        if (!refreshTokens.has(rt)) return json(res, 400, { error: 'invalid_grant' });
        refreshTokens.delete(rt);
        const nextAt = `at-${++tokenSeq}`;
        const nextRt = `rt-${tokenSeq}`;
        accessTokens.add(nextAt);
        refreshTokens.add(nextRt);
        return json(res, 200, { access_token: nextAt, refresh_token: nextRt, token_type: 'Bearer', scope: 'read' });
      }
      const code = form.get('code') ?? '';
      const scope = codes.get(code);
      requests.push(`POST /token grant_type=authorization_code valid=${scope !== undefined}`);
      if (scope === undefined) return json(res, 400, { error: 'invalid_grant' });
      codes.delete(code);
      const nextAt = `at-${++tokenSeq}`;
      accessTokens.add(nextAt);
      const body: Record<string, string> = { access_token: nextAt, token_type: 'Bearer', scope };
      if (issueRefreshToken) {
        const nextRt = `rt-${tokenSeq}`;
        refreshTokens.add(nextRt);
        body.refresh_token = nextRt;
      }
      return json(res, 200, body);
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const metadata = `resource_metadata="${base}/.well-known/oauth-protected-resource"`;
      const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!accessTokens.has(auth)) {
        requests.push('POST /mcp 401');
        return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer ${metadata}, scope="read"` });
      }
      const message = JSON.parse(await readBody(req)) as { id?: number; method: string; params?: { name?: string } };
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      requests.push(`POST /mcp 200 ${message.method}`);
      if (message.method === 'initialize') {
        return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'notes', version: '1' } } });
      }
      if (message.method === 'tools/list') {
        return json(res, 200, {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [{
              name: 'list_notes',
              description: 'List meeting notes',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true, openWorldHint: false },
            }],
          },
        });
      }
      if (message.method === 'tools/call') {
        return json(res, 200, {
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: 'Meeting notes: Ship S7 relogin by Friday.' }] },
        });
      }
      return json(res, 200, { jsonrpc: '2.0', id: message.id, result: {} });
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${base}/mcp`,
    requests,
    get issueRefreshToken() { return issueRefreshToken; },
    set issueRefreshToken(v: boolean) { issueRefreshToken = v; },
    expireAccessTokens: () => { accessTokens.clear(); },
    revokeRefreshTokens: () => { refreshTokens.clear(); },
    reset: () => { codes.clear(); accessTokens.clear(); refreshTokens.clear(); requests.length = 0; issueRefreshToken = true; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

let fakeServer: FakeNotesServer;
let workspace = '';
let db: Database.Database | undefined;
let ipcHandler: HandlerFn;

beforeAll(async () => {
  fakeServer = await startFakeNotesServer();
});

afterAll(async () => {
  await fakeServer.close();
});

beforeEach(() => {
  fakeServer.reset();
  mocks.storage.values.clear();
  mocks.shell.opened.length = 0;
  mocks.shell.autoAuthorize = true;
  mocks.messages.length = 0;
  mocks.events.length = 0;
  mocks.warn.mockClear();
  mocks.info.mockClear();
  Object.assign(mocks.cli, {
    connected: false,
    statusCalls: [],
    connectCalls: 0,
    executeCalls: 0,
    connectSucceeds: true,
    silentStatusRecovers: false,
  });
  resetToolResolver();
  vi.spyOn(ipcHost, 'handle').mockImplementation((_c, fn) => { ipcHandler = fn; });
});

afterEach(async () => {
  registerEnvResumeContinuer(null);
  clearEnvResumeWaiter('login-run');
  const client = getMCPClient();
  await client.disconnect('notes').catch(() => undefined);
  client.removeServer('notes');
  getApplicationRunRegistry().clear();
  db?.close();
  db = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (workspace) { rmSync(workspace, { recursive: true, force: true }); workspace = ''; }
});

async function setupDurableHarness() {
  workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'env-login-s7-')));
  db = new Database(':memory:');
  const logger = createLogger('LoginS7Fixture');
  applySchema(db, logger);
  applySessionsMigrations(db, logger);
  applyIndexes(db);
  const sessions = new SessionRepository(db);
  const events = new ToolExecutionEventRepository(db);
  const repository = new DurableRunRepository(db);
  repository.migrate();
  const registry = getApplicationRunRegistry();
  registry.clear();
  registry.configureDurableKernel(new DurableRunKernel({
    stores: repository,
    ownerId: 'login-host',
    processInstanceId: `login-proc-${process.pid}`,
    leaseDurationMs: 120_000,
  }));
  const sessionId = 'login-session';
  const runId = 'login-run';
  const sourceId = 'login-source';
  const toolCallId = 'login-call';
  let resumes = 0;
  let lastResumedHistory: Message[] = [];

  setToolLedgerSink({
    appendToolExecutionBegin: (input) => events.appendBegin(input),
    appendToolExecutionComplete: (input) => events.appendComplete(input),
    appendPermissionDecision: () => {},
  });

  const messages = () => sessions.getMessages(sessionId);
  const persist = async (_s: string, message: Message) => { sessions.addMessage(sessionId, message); };

  const executor = () => {
    const instance = new ToolExecutor({ workingDirectory: workspace, requestPermission: async () => true });
    instance.setAuditEnabled(false);
    return instance;
  };

  const tasks = {
    getSessionState: () => ({ status: 'idle' }),
    resumeExistingDurableRun: async (_session: string, resumedId: string, history: Message[]) => {
      resumes++;
      lastResumedHistory = history;
      if (resumedId !== runId) throw new Error('run identity changed');
      sessions.updateSession(sessionId, { status: 'running' });
      const handle = registry.adoptRecoveredRun({ runId, sessionId, workspace, cwd: workspace });
      await finalizeOrParkDurableRun({ registry, runId, handle, sessionId, completed: true });
      registry.unregister(runId, handle);
      sessions.updateSession(sessionId, { status: 'idle' });
    },
  } as unknown as TaskManager;

  mocks.db = {
    getDb: () => db,
    getSession: (id: string) => sessions.getSession(id),
    getMessages: () => messages(),
    getToolExecutionsBySession: (id: string) => events.getBySession(id),
    addMessage: (id: string, message: Message) => sessions.addMessage(id, message),
    appendToolExecutionComplete: (input: Parameters<typeof events.appendComplete>[0]) => events.appendComplete(input),
  };

  const ports = createApplicationNativeRecoveryPorts(registry, {
    sessions: { getMessages: async () => messages(), updateMessage: async () => {} },
    tasks,
    persistToolMessage: persist,
    resolveToolDefinition: (name) => {
      const mcpDef = getMCPClient().getToolDefinitions().find((d) => d.name === name);
      return mcpDef ?? getToolDefinitionWithCloudMeta(name);
    },
    toolExecutions: (id) => events.getBySession(id),
    storedToolReplaySafety: (_id, executionId) => events.getBySession(sessionId).find((e) => e.executionId === executionId && e.phase === 'begin')?.replaySafety ?? null,
    acknowledgeToolRecovery: (_id, executionId, toolName) => { if (executionId) events.appendComplete({ executionId, sessionId, toolName, status: 'recovered', recordedAt: Date.now() }); },
    executeTool: async (input) => {
      const plan = await registry.getDurableRehydrationPlan(runId);
      const handle = registry.bindRecoveredHandle(plan, workspace);
      try {
        return await executor().execute(input.name, input.arguments, {
          runId,
          sessionId,
          sourceMessageId: sourceId,
          currentToolCallId: input.toolCallId,
        });
      } finally {
        registry.unregister(runId, handle);
      }
    },
  });

  registerAgentContinueRoute(
    { post: () => {} } as unknown as Router,
    registry,
    () => tasks,
    async () => messages(),
    envResumeProbeFactory,
  );
  registerEnvAssistHandlers({
    available: () => false,
    open: vi.fn(async () => false),
    findNotice: async (id) => mocks.messages.find((m) => m.id === `env-assist:${id}`)?.metadata?.envAssist,
    continueAfterSkip: async () => {
      await continueParkedDurableRun({
        sessionId,
        expectedRunId: runId,
        runRegistry: registry,
        taskManager: tasks,
        getMessages: async () => messages(),
        envRecoveryPorts: ports,
      });
    },
  });

  const callIpc = async (action: string, payload: unknown) => ((await ipcHandler({} as never, { action, payload })) as { data: unknown }).data;

  const runToolTurn = async (toolName: string, args: Record<string, unknown> = {}) => {
    sessions.createSessionWithId(sessionId, {
      title: 'Meeting notes summary',
      modelConfig: { provider: 'openai', model: 'fixture' },
      workingDirectory: workspace,
    });
    sessions.addMessage(sessionId, { id: sourceId, role: 'user', content: 'List today meeting notes', timestamp: 1 });
    sessions.addMessage(sessionId, { id: 'assistant-1', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: toolCallId, name: toolName, arguments: args }] });
    const handle = await registry.startDurable({ runId, sessionId, workspace, cwd: workspace });
    const exec = executor();
    const { ctx, engine } = makeEngine(exec.execute.bind(exec) as never);
    Object.assign(ctx, { workingDirectory: workspace, runId, sessionId, messages: messages() });
    const emitted: AgentEvent[] = [];
    Object.assign(ctx, { onEvent: (event: AgentEvent) => { emitted.push(event); } });
    const results = await engine.executeToolsWithHooks([{ id: toolCallId, name: toolName, arguments: args }]);
    await finalizeOrParkDurableRun({ registry, runId, handle, sessionId, completed: !ctx.control.isCancelled, cancelled: ctx.control.isCancelled });
    return { ctx, emitted, results };
  };

  return {
    sessionId,
    runId,
    toolCallId,
    registry,
    repository,
    sessions,
    messages,
    ports,
    callIpc,
    runToolTurn,
    getResumes: () => resumes,
    getLastResumedHistory: () => lastResumedHistory,
  };
}

describe('N-ENV-ASSIST-S7-RELOGIN layered recovery (ToolExecutionEngine -> toolResolver -> envAssist.ipc -> envResumeWaiter -> continueParkedDurableRun)', () => {
  it('MCP 401 with valid refresh token silently refreshes without card or browser redirect', async () => {
    const client = getMCPClient();
    const config = { name: 'notes', type: 'http-streamable' as const, serverUrl: fakeServer.url, enabled: true, auth: 'oauth' as const };
    client.addServer(config);
    await client.connect(config).catch(() => {});
    await client.waitForPendingOAuthAuthorization('notes');
    expect(client.isConnected('notes')).toBe(true);
    mocks.shell.opened.length = 0;

    fakeServer.expireAccessTokens();
    const f = await setupDurableHarness();
    const { emitted, results } = await f.runToolTurn('mcp__notes__list_notes', {});

    expect(results[0]).toMatchObject({ success: true, output: 'Meeting notes: Ship S7 relogin by Friday.' });
    expect(mocks.shell.opened).toHaveLength(0);
    expect(fakeServer.requests).toContain('POST /token grant_type=refresh_token valid=true');
    expect(emitted.filter((e) => e.type === 'env_assist_notice' || e.type === 'connector_required')).toEqual([]);
    expect(mocks.messages.filter((m) => m.id.startsWith('env-assist:'))).toHaveLength(0);
    expect((await f.repository.get(f.runId))?.status).toBe('completed');
  }, 30_000);

  it('MCP 401 with revoked refresh token runs silent recovery (logged), parks as login_expired, reauthorizes via envAssist.act, and resumes the same tool call', async () => {
    const client = getMCPClient();
    const config = { name: 'notes', type: 'http-streamable' as const, serverUrl: fakeServer.url, enabled: true, auth: 'oauth' as const };
    client.addServer(config);
    await client.connect(config).catch(() => {});
    await client.waitForPendingOAuthAuthorization('notes');
    mocks.shell.opened.length = 0;

    fakeServer.expireAccessTokens();
    fakeServer.revokeRefreshTokens();

    const f = await setupDurableHarness();
    const { emitted } = await f.runToolTurn('mcp__notes__list_notes', {});

    // 1. Silent recovery ran and logged distinguishable failure without opening browser.
    expect(mocks.shell.opened).toHaveLength(0);
    expect(mocks.warn).toHaveBeenCalledWith('Login silent recovery failed', expect.objectContaining({
      kind: 'mcp',
      connectorId: 'notes',
      reason: 'refresh_failed',
    }));

    // 2. Run parked as login_expired; exactly one env_assist_notice card, zero competing connector_required cards.
    expect(await f.repository.get(f.runId)).toMatchObject({
      status: 'waiting',
      interruptCause: 'env_blocked',
      envBlocked: { class: 'login_expired', target: 'notes', toolCallId: f.toolCallId },
    });
    expect(emitted.filter((e) => e.type === 'connector_required')).toEqual([]);
    const notice = emitted.find((e) => e.type === 'env_assist_notice')?.data as EnvAssistNotice;
    expect(notice).toMatchObject({
      id: `${f.runId}|login_expired|notes`,
      class: 'login_expired',
      phase: 'needs_user',
      target: { id: 'notes' },
      sentenceKey: 'env.sentence.loginExpired',
      action: { kind: 'reauthorize', labelKey: 'env.allow.loginExpired', payload: { serverName: 'notes' } },
    });
    expect(client.isConnected('notes')).toBe(false);

    // 3. User clicks "Sign in again" -> envAssist.act reauthorize -> reauthorizeMcpServer opens browser & connects -> card resolves & run resumes!
    const actResult = await f.callIpc('act', {
      noticeId: notice.id,
      actionKind: 'reauthorize',
      payload: { serverName: 'notes' },
    });
    expect(actResult).toMatchObject({
      status: 'checked',
      outcome: { status: 'granted' },
      notice: { id: notice.id, phase: 'resolved', doneKey: 'env.done.loginExpired' },
    });
    expect(mocks.shell.opened).toHaveLength(1);
    expect(client.isConnected('notes')).toBe(true);

    // 4. Probe goes green and continues the parked run without a new user message.
    await vi.waitFor(async () => expect((await f.repository.get(f.runId))?.status).toBe('completed'), { timeout: 5_000 });
    expect(f.getResumes()).toBe(1);
    const replayed = f.messages().find((m) => m.role === 'tool')?.toolResults?.[0];
    expect(replayed).toMatchObject({
      toolCallId: f.toolCallId,
      success: true,
      output: 'Meeting notes: Ship S7 relogin by Friday.',
    });
    expect(f.messages().filter((m) => m.role === 'user')).toHaveLength(1);
  }, 30_000);

  it('login_expired waiter window covers OAUTH_FLOW_TIMEOUT_MS (300s), not 120s default', async () => {
    vi.useFakeTimers();
    const continues = vi.fn(async () => undefined);
    let connected = false;
    registerEnvResumeContinuer(continues, () => async () => (connected ? 'green' : 'red'));
    armEnvResumeOnPark({
      runId: 'login-run',
      sessionId: 'login-session',
      envBlocked: { class: 'login_expired', target: 'notes', toolCallId: 'login-call' },
    });

    // Past the 120s default permission window: login_expired waiter must still be alive.
    await vi.advanceTimersByTimeAsync(ENV_RESUME_TIMEOUT_MS + 10_000);
    expect(mocks.warn).not.toHaveBeenCalledWith('Environment auto-continue stopped', expect.anything());
    expect(continues).not.toHaveBeenCalled();

    // Completing OAuth at 130s still resumes automatically.
    connected = true;
    await vi.advanceTimersByTimeAsync(ENV_RESUME_POLL_INTERVAL_MS);
    await vi.waitFor(() => expect(continues).toHaveBeenCalledTimes(1));

    // And a fresh login_expired waiter stops cleanly after OAUTH_FLOW_TIMEOUT_MS.
    connected = false;
    armEnvResumeOnPark({
      runId: 'login-run',
      sessionId: 'login-session',
      envBlocked: { class: 'login_expired', target: 'notes', toolCallId: 'login-call' },
    });
    await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS + 1);
    expect(mocks.warn).toHaveBeenCalledWith('Environment auto-continue stopped', expect.objectContaining({ reason: 'timeout' }));
  });

  it('CLI connector (feishuMinutesSearch -> cli_not_logged_in): silent status(true) fails -> parks -> CLI connect via envAssist.act -> resumes', async () => {
    const protocol = getProtocolRegistry();
    const registered = !protocol.has('feishuMinutesSearch');
    if (registered) protocol.register(feishuMinutesSearchSchema, async () => feishuMinutesSearchModule);
    try {
      const f = await setupDurableHarness();
      const { emitted } = await f.runToolTurn('feishuMinutesSearch', { query: 'weekly' });

      expect(mocks.cli.statusCalls).toEqual([true]);
      expect(mocks.warn).toHaveBeenCalledWith('Login silent recovery failed', expect.objectContaining({
        kind: 'cli',
        connectorId: 'feishu',
        reason: 'cli_not_logged_in',
      }));
      expect(await f.repository.get(f.runId)).toMatchObject({
        status: 'waiting',
        interruptCause: 'env_blocked',
        envBlocked: { class: 'login_expired', target: 'feishu', toolCallId: f.toolCallId },
      });
      const notice = emitted.find((e) => e.type === 'env_assist_notice')?.data as EnvAssistNotice;
      expect(notice).toMatchObject({
        id: `${f.runId}|login_expired|feishu`,
        class: 'login_expired',
        phase: 'needs_user',
        target: { id: 'feishu' },
        action: { kind: 'reauthorize', payload: { serverName: 'feishu' } },
      });

      // Click "Sign in again" -> CLI connect runs -> card resolves -> parked run replays feishuMinutesSearch!
      const actResult = await f.callIpc('act', {
        noticeId: notice.id,
        actionKind: 'reauthorize',
        payload: { serverName: 'feishu' },
      });
      expect(actResult).toMatchObject({
        status: 'checked',
        outcome: { status: 'granted' },
        notice: { phase: 'resolved', doneKey: 'env.done.loginExpired' },
      });
      expect(mocks.cli.connectCalls).toBe(1);

      await vi.waitFor(async () => expect((await f.repository.get(f.runId))?.status).toBe('completed'), { timeout: 5_000 });
      expect(f.getResumes()).toBe(1);
      const replayed = f.messages().find((m) => m.role === 'tool')?.toolResults?.[0];
      expect(replayed).toMatchObject({
        toolCallId: f.toolCallId,
        success: true,
        output: expect.stringContaining('Weekly Sync'),
      });
    } finally {
      if (registered) protocol.unregister('feishuMinutesSearch');
    }
  }, 30_000);

  it('CLI connector silent status(true) recovery succeeds -> retries tool call once with NO card', async () => {
    const protocol = getProtocolRegistry();
    const registered = !protocol.has('feishuMinutesSearch');
    if (registered) protocol.register(feishuMinutesSearchSchema, async () => feishuMinutesSearchModule);
    try {
      mocks.cli.silentStatusRecovers = true;
      const f = await setupDurableHarness();
      const { emitted, results } = await f.runToolTurn('feishuMinutesSearch', { query: 'weekly' });

      expect(mocks.cli.statusCalls).toEqual([true]);
      expect(mocks.cli.executeCalls).toBe(2);
      expect(results[0]).toMatchObject({ success: true, output: expect.stringContaining('Weekly Sync') });
      expect(emitted.filter((e) => e.type === 'env_assist_notice')).toEqual([]);
      expect(mocks.messages.filter((m) => m.id.startsWith('env-assist:'))).toHaveLength(0);
    } finally {
      if (registered) protocol.unregister('feishuMinutesSearch');
    }
  });

  it('cancel/abandon login turns card unconfirmed (honest copy + retry + skip), rejects forged payload, and skip_step resumes with skipped result', async () => {
    const protocol = getProtocolRegistry();
    const registered = !protocol.has('feishuMinutesSearch');
    if (registered) protocol.register(feishuMinutesSearchSchema, async () => feishuMinutesSearchModule);
    try {
      mocks.cli.connectSucceeds = false;
      const f = await setupDurableHarness();
      const { emitted } = await f.runToolTurn('feishuMinutesSearch', { query: 'weekly' });
      const notice = emitted.find((e) => e.type === 'env_assist_notice')?.data as EnvAssistNotice;

      // Forged serverName and premature skip_step are rejected.
      expect(await f.callIpc('act', { noticeId: notice.id, actionKind: 'reauthorize', payload: { serverName: 'other' } })).toMatchObject({ status: 'rejected' });
      expect(await f.callIpc('act', { noticeId: notice.id, actionKind: 'skip_step', payload: { serverName: 'feishu' } })).toMatchObject({ status: 'rejected' });

      // User cancels login -> card becomes unconfirmed with Retry action.
      const cancelled = await f.callIpc('act', { noticeId: notice.id, actionKind: 'reauthorize', payload: { serverName: 'feishu' } });
      expect(cancelled).toMatchObject({
        status: 'checked',
        outcome: { status: 'denied' },
        notice: {
          id: notice.id,
          phase: 'unconfirmed',
          sentenceKey: 'env.sentence.loginUnconfirmed',
          action: { kind: 'reauthorize', labelKey: 'env.retry.loginExpired', payload: { serverName: 'feishu' } },
        },
      });

      // User clicks secondary skip -> card becomes declined and parked run continues with skipped result.
      const skipped = await f.callIpc('act', { noticeId: notice.id, actionKind: 'skip_step', payload: { serverName: 'feishu' } });
      expect(skipped).toMatchObject({
        status: 'checked',
        notice: {
          id: notice.id,
          phase: 'declined',
          sentenceKey: 'env.sentence.loginSkipped',
        },
      });
      await vi.waitFor(async () => expect((await f.repository.get(f.runId))?.status).toBe('completed'), { timeout: 5_000 });
      const skippedResult = f.messages().find((m) => m.role === 'tool')?.toolResults?.[0];
      expect(skippedResult?.error).toContain('skipped: The user chose to skip signing in to feishu');
    } finally {
      if (registered) protocol.unregister('feishuMinutesSearch');
    }
  });
});
