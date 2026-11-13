// Real BrowserService + adapter/runtime, driven through browserActionTool.execute.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getApplicationRunRegistry } from '../../../../src/host/app/applicationRunRegistry';
import { browserPool } from '../../../../src/host/services/infra/browserPool';
import { getManagedBrowserProviderAdapter, surfaceIdentityFromToolContext } from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import { getSurfaceExecutionRuntime } from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { getKeptBrowserRegistry } from '../../../../src/host/services/surfaceExecution/keptBrowserRegistry';
import { browserActionTool } from '../../../../src/host/tools/vision/browserAction';
import type { ToolContext, ToolExecutionResult } from '../../../../src/host/tools/types';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../../src/shared/contract/surfaceExecution';

const adapter = getManagedBrowserProviderAdapter();
const runtime = getSurfaceExecutionRuntime();
const registry = getApplicationRunRegistry();
const kept = getKeptBrowserRegistry();
const ownedKeys = new Set<string>();
const contexts: ToolContext[] = [];
const servers: Server[] = [];
let appOrigin: string;
let idpOrigin: string;
let loggedIn = false;
let loginGets = 0;

async function origin(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  return `http://127.0.0.1:${address.port}`;
}

function context(conversationId = randomUUID(), agentId = 'park-agent'): ToolContext {
  const ctx: ToolContext = {
    sessionId: conversationId, runId: randomUUID(), agentId,
    workingDirectory: process.cwd(), workspace: process.cwd(),
    abortSignal: new AbortController().signal,
    requestPermission: async () => true,
    executionIntent: {
      browserSessionMode: 'managed', preferBrowserSession: true,
      allowBrowserAutomation: true, browserSessionSnapshot: { ready: true },
    },
  };
  const start = agentId === SURFACE_USER_BROWSER_AGENT_ID ? registry.startAuxiliary.bind(registry) : registry.start.bind(registry);
  start({ runId: ctx.runId!, sessionId: conversationId, workspace: process.cwd() });
  contexts.push(ctx);
  return ctx;
}
const identity = (ctx: ToolContext) => surfaceIdentityFromToolContext(ctx)!;
const binding = (ctx: ToolContext) => adapter.getBinding(identity(ctx))!;
async function execute(ctx: ToolContext, params: Record<string, unknown>) {
  const result = await browserActionTool.execute(params, { ...ctx, currentToolCallId: randomUUID() });
  const current = adapter.getBinding(identity(ctx));
  if (current) ownedKeys.add(current.serviceKey);
  return result;
}
function session(result: ToolExecutionResult): { sessionId: string; state: string } {
  return result.metadata?.surfaceExecutionSessionV1 as { sessionId: string; state: string };
}
function profileDir(profileId: string): string | undefined {
  const root = join(tmpdir(), 'code-agent-managed-browser-');
  return existsSync(root) ? readdirSync(root).find((name) => name.startsWith(profileId)) : undefined;
}

async function waitingHuman() {
  loggedIn = false;
  const ctx = context();
  expect((await execute(ctx, { action: 'navigate', url: `${appOrigin}/login` })).success).toBe(true);
  expect((await execute(ctx, { action: 'click', selector: '#sign-in' })).success).toBe(true);
  await vi.waitFor(() => expect(binding(ctx).browserService.getLiveTabUrl()).toBe(`${idpOrigin}/idp`));
  // Playwright reports the organic page_load separately from click completion.
  // Wait for its production observation before taking the predecessor for type.
  await vi.waitFor(() => expect(runtime.events.list(binding(ctx).surfaceSessionId).some((event) => (
    event.userSummary === 'Observed managed browser after organic page_load' && event.target?.kind === 'browser' && event.target.origin === idpOrigin
  ))).toBe(true));
  await execute(ctx, { action: 'get_dom_snapshot' });
  const mismatch = await execute(ctx, { action: 'type', selector: '#pw', secretRef: 'env:CODE_AGENT_BROWSER_SECRET_X' });
  process.stdout.write(`MISMATCH_REAL ${JSON.stringify({ code: mismatch.metadata?.code, state: session(mismatch)?.state })}\n`);
  expect(mismatch.metadata?.code, JSON.stringify(mismatch)).toBe('SECRET_REF_ORIGIN_MISMATCH');
  expect(session(mismatch).state).toBe('waiting_human');
  const before = binding(ctx);
  return { ctx, before, subject: { sessionId: session(mismatch).sessionId, runId: ctx.runId!, agentId: ctx.agentId! } };
}

beforeAll(async () => {
  vi.stubEnv('CODE_AGENT_BROWSER_PROVIDER', 'playwright-bundled');
  vi.stubEnv('CODE_AGENT_BROWSER_VISIBLE', '');
  vi.stubEnv('CODE_AGENT_BROWSER_SECRET_X', 'fixture-value-never-typed');
  vi.stubEnv('CODE_AGENT_BROWSER_SECRET_X_ORIGINS', 'https://allowed.example.test');
  appOrigin = await origin((_req, res) => {
    loginGets += 1;
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'probe_app=present; Path=/' });
    res.end(`<h1>Login</h1><a id="sign-in" href="${idpOrigin}/idp">Sign in</a>`);
  });
  idpOrigin = await origin((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(loggedIn ? '<h1>LOGGED-IN-MARKER</h1>' : '<h1>Sign in</h1><input id="pw" type="password">');
  });
});

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await runtime.endRun(identity(ctx)).catch(() => undefined);
    registry.unregister(ctx.runId!);
  }
  for (const key of ownedKeys) await browserPool.releaseAgent(key);
  ownedKeys.clear();
});
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.unstubAllEnvs();
});

describe('managed browser takeover park', () => {
  it('parks the real browser at run end and next run claims the same logged-in page', async () => {
    const h = await waitingHuman();
    const profile = h.before.browserService.getSessionState().profileId!;
    await runtime.endRun(identity(h.ctx));
    const running = h.before.browserService.isRunning();
    const storage = running ? await h.before.browserService.exportStorageState() : null;
    const cookies = (storage ? JSON.parse(readFileSync(storage.path, 'utf8')).cookies : []) as Array<{ name: string }>;
    const result = {
      running,
      probeAppCookie: cookies.some((cookie) => cookie.name === 'probe_app'),
      profileDirExists: Boolean(profileDir(profile)),
      sessionState: runtime.sessions.get(h.subject.sessionId)?.state,
      kept: kept.snapshot(h.ctx.sessionId!),
    };
    process.stdout.write(`PARK_REAL ${JSON.stringify(result)}\n`);
    expect(result).toMatchObject({ running: true, probeAppCookie: true, profileDirExists: true, sessionState: 'completed', kept: { state: 'kept', reason: 'takeover' } });
    await expect(runtime.control(h.subject, 'resume')).rejects.toThrow('Cannot resume a Surface session while completed');
    // The user has completed sign-in and refreshed the SAME live browser.
    loggedIn = true;
    await h.before.browserService.reload();
    const getsBeforeContinue = loginGets;
    registry.unregister(h.ctx.runId!);
    const next = context(h.ctx.sessionId);
    const staleNavigation = await execute(next, { action: 'navigate', url: `${appOrigin}/login` });
    expect(staleNavigation.success).toBe(false);
    expect(staleNavigation.error).toContain('get_dom_snapshot before acting');
    expect(loginGets).toBe(getsBeforeContinue);
    const snapshot = await execute(next, { action: 'get_dom_snapshot' });
    const claimed = binding(next);
    const page = await claimed.browserService.getPageContent();
    process.stdout.write(`CLAIM_REAL ${JSON.stringify({ sameServiceKey: claimed.serviceKey === h.before.serviceKey, sameProfile: claimed.browserService.getSessionState().profileId === profile, page: page.text, loginGetsUnchanged: loginGets === getsBeforeContinue })}\n`);
    expect(snapshot.success).toBe(true);
    expect(snapshot.output).toContain('get_dom_snapshot before acting');
    expect(claimed.serviceKey).toBe(h.before.serviceKey);
    expect(claimed.browserService).toBe(h.before.browserService);
    expect(claimed.browserService.getSessionState().profileId).toBe(profile);
    expect(page.text).toContain('LOGGED-IN-MARKER');
    expect(loginGets).toBe(getsBeforeContinue);
    expect(kept.snapshot(next.sessionId!).state).toBe('none');
    expect((await execute(next, { action: 'get_dom_snapshot' })).output).not.toContain('get_dom_snapshot before acting');
  }, 60_000);

  it('closed windows become closed and cannot be claimed by the next run', async () => {
    const h = await waitingHuman();
    await runtime.endRun(identity(h.ctx));
    await h.before.browserService.close();
    expect(kept.snapshot(h.ctx.sessionId!)).toMatchObject({ state: 'closed', reason: 'takeover' });
    registry.unregister(h.ctx.runId!);
    const next = context(h.ctx.sessionId);
    expect((await execute(next, { action: 'navigate', url: `${idpOrigin}/idp` })).success).toBe(true);
    expect(binding(next).serviceKey).not.toBe(h.before.serviceKey);
  }, 60_000);

  it('explicit Stop releases the window instead of parking it', async () => {
    const h = await waitingHuman();
    await runtime.control(h.subject, 'stop');
    await runtime.endRun(identity(h.ctx));
    expect(h.before.browserService.isRunning()).toBe(false);
    expect(kept.snapshot(h.ctx.sessionId!).state).toBe('none');
  }, 60_000);

  it('a different conversation cannot claim the parked login', async () => {
    const h = await waitingHuman();
    await runtime.endRun(identity(h.ctx));
    const other = context();
    expect((await execute(other, { action: 'navigate', url: `${idpOrigin}/idp` })).success).toBe(true);
    expect(binding(other).serviceKey).not.toBe(h.before.serviceKey);
    expect(kept.snapshot(h.ctx.sessionId!).state).toBe('kept');
  }, 60_000);

  it('parks and claims even when a live user-panel binding shares the browser', async () => {
    const h = await waitingHuman();
    const user = context(h.ctx.sessionId, SURFACE_USER_BROWSER_AGENT_ID);
    expect((await execute(user, { action: 'get_dom_snapshot' })).success).toBe(true);
    expect(binding(user).serviceKey).toBe(h.before.serviceKey);
    await runtime.endRun(identity(h.ctx));
    expect(kept.snapshot(h.ctx.sessionId!)).toMatchObject({ state: 'kept', reason: 'takeover' });
    registry.unregister(h.ctx.runId!);
    const next = context(h.ctx.sessionId);
    const result = await execute(next, { action: 'get_dom_snapshot' });
    expect(result.output).toContain('get_dom_snapshot before acting');
    expect(binding(next).serviceKey).toBe(h.before.serviceKey);
    expect(kept.snapshot(h.ctx.sessionId!).state).toBe('none');
  }, 60_000);
});
