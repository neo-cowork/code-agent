import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getApplicationRunRegistry,
  resetApplicationRunRegistryForTests,
} from '../../../../src/host/app/applicationRunRegistry';
import { getKeptResultPageHandler } from '../../../../src/host/ipc/workspaceKeptResultPage';
import { MANAGED_BROWSER_MIN_LEASE_TTL_MS } from '../../../../src/host/services/infra/browser/managedBrowserHelpers';
import { browserPool } from '../../../../src/host/services/infra/browserPool';
import {
  getManagedBrowserProviderAdapter,
  resetManagedBrowserProviderAdapterForTests,
} from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import {
  getSurfaceExecutionRuntime,
  resetSurfaceExecutionRuntimeForTests,
  type SurfaceRuntimeIdentityV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import { UserBrowserLinkService } from '../../../../src/host/services/surfaceExecution/UserBrowserLinkService';
import type { ToolContext } from '../../../../src/host/tools/types';
import { browserActionTool } from '../../../../src/host/tools/vision/browserAction';
import { BROWSER_TIMEOUTS } from '../../../../src/shared/constants/timeouts';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../../src/shared/contract/surfaceExecution';

const TIMEOUT_MS = 120_000;
const RESULT_PATH = '/result?id=abc123';
const SUCCESS_MARKER = 'SUBMITTED-OK';
const FORM_PAGE = `<!doctype html><html><head><title>Sign up</title></head><body>
<form method="POST" action="/submit"><input id="name" name="name"><input id="phone" name="phone">
<button id="send" type="submit">Send</button></form></body></html>`;
const RESULT_PAGE = `<!doctype html><html><head><title>Submitted</title></head><body>
<h1 id="marker">${SUCCESS_MARKER}</h1></body></html>`;

describe('kept result page reopen (real chromium)', () => {
  const workspace = process.cwd();
  let server: Server;
  let origin: string;
  let resultUrl: string;
  let conversationId: string;

  beforeAll(async () => {
    vi.stubEnv('CODE_AGENT_BROWSER_PROVIDER', 'playwright-bundled');
    vi.stubEnv('CODE_AGENT_BROWSER_VISIBLE', '0');
    server = createServer((req, res) => {
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, headers).end(FORM_PAGE);
      } else if (req.method === 'POST' && req.url === '/submit') {
        req.resume();
        req.on('end', () => res.writeHead(303, { location: RESULT_PATH }).end());
      } else if (req.method === 'GET' && req.url === RESULT_PATH) {
        res.writeHead(200, headers).end(RESULT_PAGE);
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resultUrl = origin + RESULT_PATH;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  beforeEach(() => {
    conversationId = `kept-reopen-${randomUUID()}`;
    resetManagedBrowserProviderAdapterForTests();
    resetSurfaceExecutionRuntimeForTests();
    resetApplicationRunRegistryForTests();
  });

  afterEach(async () => {
    await Promise.all(browserPool.listAgents().map((key) => browserPool.releaseAgent(key)));
    await getManagedBrowserProviderAdapter().clearConversationResumeState(conversationId);
  });

  async function submitAndKeep(links: UserBrowserLinkService) {
    const runId = `reopen-run-${conversationId}`;
    const agentId = 'reopen-agent';
    getApplicationRunRegistry().start({ runId, sessionId: conversationId, workspace });
    const identity: SurfaceRuntimeIdentityV1 = { conversationId, runId, agentId };
    const context = {
      sessionId: conversationId,
      runId,
      agentId,
      workingDirectory: workspace,
      requestPermission: async () => true,
    } as unknown as ToolContext;
    const execute = async (params: Record<string, unknown>) => {
      const result = await browserActionTool.execute(params, context);
      expect(result.success, `${String(params.action)}: ${result.error ?? ''}`).toBe(true);
    };

    await execute({ action: 'navigate', url: origin + '/' });
    await execute({ action: 'type', selector: '#name', text: 'Fixture Name' });
    await execute({ action: 'type', selector: '#phone', text: '2025550100' });
    await execute({ action: 'click', selector: '#send' });

    const service = getManagedBrowserProviderAdapter().getBinding(identity)?.browserService;
    if (!service) throw new Error('Missing browser binding after submit');
    // Wait for BrowserService's organic navigation metadata before keep captures it.
    await vi.waitFor(() => {
      expect(service.getActiveTab()?.url).toBe(resultUrl);
    });

    await execute({ action: 'keep_result_page' });
    const captured = getKeptResultPageHandler(links, { conversationId });
    console.log('[reopen] handler at keep:', JSON.stringify(captured));
    expect.soft(captured.url, '② URL captured at keep').toBe(resultUrl);
    await getSurfaceExecutionRuntime().endRun(identity);
    return service;
  }

  it('reopens the GET-stable submitted result on the active tab after close', async () => {
    const links = new UserBrowserLinkService();
    const response = await fetch(resultUrl, { redirect: 'error' });
    const html = await response.text();
    console.log('[reopen] direct GET response:', html);
    expect(response.status).toBe(200);
    expect(html).toContain(SUCCESS_MARKER);

    const service = await submitAndKeep(links);
    const kept = getKeptResultPageHandler(links, { conversationId });
    console.log('[reopen] handler after endRun:', JSON.stringify(kept));
    expect(kept.state).toBe('kept');
    // Continue through reopen even when a mutation stores the wrong URL.
    expect.soft(kept.url, '② URL retained after endRun').toBe(resultUrl);

    await service.close();
    const closed = getKeptResultPageHandler(links, { conversationId });
    console.log('[reopen] handler after close:', JSON.stringify(closed));
    expect(closed.state).toBe('closed');
    expect(closed.url).toBe(kept.url);

    try {
      const opened = await links.open({ conversationId, workspace, url: closed.url });
      const binding = getManagedBrowserProviderAdapter().getBinding({
        conversationId, runId: opened.runId, agentId: SURFACE_USER_BROWSER_AGENT_ID,
      });
      const tab = binding?.browserService.getActiveTab();
      if (!tab) throw new Error('Reopen did not leave an active tab');
      const url = tab.page.url();
      const marker = tab.page.locator('#marker');
      const visible = await marker.isVisible();
      const markerText = visible ? await marker.innerText() : null;
      console.log('[reopen] active tab:', JSON.stringify({ url, visible, markerText }));
      expect(url).toBe(closed.url);
      expect.soft(url, '③ reopened active tab URL').toBe(resultUrl);
      expect(visible, '③ success marker visible on the active tab').toBe(true);
      expect(markerText).toBe(SUCCESS_MARKER);
    } finally {
      try {
        await links.end(conversationId);
      } finally {
        // Reopening a closed result uses the personal service, outside named pool cleanup.
        await browserPool.acquire().close();
      }
    }
  }, TIMEOUT_MS);

  it('keeps the result URL when the managed browser lease expires', async () => {
    const links = new UserBrowserLinkService();
    const service = await submitAndKeep(links);
    const kept = getKeptResultPageHandler(links, { conversationId });
    expect(kept.state).toBe('kept');
    expect(kept.url).toBe(resultUrl);

    const originalTtlMs = service.getSessionState().lease?.ttlMs;
    expect(originalTtlMs).toBe(BROWSER_TIMEOUTS.POOL_IDLE_RECLAIM);
    expect(service.isLeaseInUse()).toBe(false);
    let closedByLease = false;
    const unsubscribe = service.onSessionChanged((reason) => {
      if (reason === 'close') closedByLease = true;
    });
    try {
      const { lease } = await service.ensureSession('about:blank', { leaseTtlMs: MANAGED_BROWSER_MIN_LEASE_TTL_MS });
      expect(lease?.ttlMs).toBe(MANAGED_BROWSER_MIN_LEASE_TTL_MS);
      console.log('[reopen] idle lease TTLs:', JSON.stringify({ originalTtlMs, testTtlMs: lease?.ttlMs }));
      await vi.waitFor(() => {
        expect(closedByLease, 'managed browser lease timer closed the session').toBe(true);
      }, { timeout: MANAGED_BROWSER_MIN_LEASE_TTL_MS * 3 });
    } finally {
      unsubscribe();
    }
    expect(service.isRunning()).toBe(false);
    const expired = getKeptResultPageHandler(links, { conversationId });
    console.log('[reopen] handler after idle lease expiry:', JSON.stringify(expired));
    expect(expired.state).toBe('closed');
    expect(expired.url).toBe(kept.url);
  }, TIMEOUT_MS);
});
