/**
 * Real-chromium (in-gate) — kept result page claim path with REAL chromium (N-BROWSER-KEEP-RESULT-PAGE-FU1).
 *
 * 真 BrowserService + 真 ManagedBrowserProviderAdapter / SurfaceExecutionRuntime /
 * UserBrowserLinkService / KeptBrowserRegistry，只走生产入口：
 *   browserActionTool.execute（navigate/type/click/keep_result_page）→ runtime.endRun
 *   → getKeptResultPageHandler / adoptKeptResultPageHandler → UserBrowserLinkService.dispatchUserInput。
 *
 * 跑法：npx vitest run tests/unit/services/surfaceExecution/keptResultPage.realChromium.test.ts
 * 依赖：playwright bundled chromium（headless）。
 */

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { execFileSync } from 'child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CODE_AGENT_BROWSER_PROVIDER = 'playwright-bundled';

import { browserActionTool } from '../../../../src/host/tools/vision/browserAction';
import type { ToolContext } from '../../../../src/host/tools/types';
import {
  getApplicationRunRegistry,
  resetApplicationRunRegistryForTests,
} from '../../../../src/host/app/applicationRunRegistry';
import {
  getSurfaceExecutionRuntime,
  resetSurfaceExecutionRuntimeForTests,
  type SurfaceRuntimeIdentityV1,
} from '../../../../src/host/services/surfaceExecution/SurfaceExecutionRuntime';
import {
  getManagedBrowserProviderAdapter,
  resetManagedBrowserProviderAdapterForTests,
} from '../../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';
import { UserBrowserLinkService } from '../../../../src/host/services/surfaceExecution/UserBrowserLinkService';
import {
  adoptKeptResultPageHandler,
  getKeptResultPageHandler,
} from '../../../../src/host/ipc/workspaceKeptResultPage';
import { browserPool } from '../../../../src/host/services/infra/browserPool';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../../src/shared/contract/surfaceExecution';

const TIMEOUT_MS = 120_000;

const FORM_PAGE = `<!doctype html><html><head><title>Sign up</title></head><body>
<form method="POST" action="/submit"><input id="name" name="name"><input id="phone" name="phone">
<button id="send" type="submit">Send</button></form></body></html>`;
const DONE_PAGE = `<!doctype html><html><head><title>Submitted</title></head><body>
<h1 id="marker">SUBMITTED-OK</h1><input id="note" type="text"></body></html>`;

describe('kept result page claim path (real chromium)', () => {
  let server: Server | undefined;
  let origin = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.method === 'POST') {
        req.resume();
        req.on('end', () => res.end(DONE_PAGE));
        return;
      }
      res.end(FORM_PAGE);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await Promise.all(browserPool.listAgents().map((key) => browserPool.releaseAgent(key)));
    await new Promise<void>((resolve) => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    resetManagedBrowserProviderAdapterForTests();
    resetSurfaceExecutionRuntimeForTests();
    resetApplicationRunRegistryForTests();
  });

  function startAgentRun(conversationId: string) {
    const runId = `smoke-run-${conversationId}`;
    getApplicationRunRegistry().start({ runId, sessionId: conversationId, workspace: process.cwd() });
    const identity: SurfaceRuntimeIdentityV1 = { conversationId, runId, agentId: 'smoke-agent' };
    const context = {
      sessionId: conversationId,
      runId,
      agentId: 'smoke-agent',
      workingDirectory: process.cwd(),
      requestPermission: async () => true,
    } as unknown as ToolContext;
    const exec = async (params: Record<string, unknown>) => {
      const result = await browserActionTool.execute(params, context);
      expect(result.success, `${String(params.action)}: ${result.error ?? ''}`).toBe(true);
      return result;
    };
    return { identity, exec };
  }

  async function submitAndKeep(conversationId: string) {
    const { identity, exec } = startAgentRun(conversationId);
    await exec({ action: 'navigate', url: origin });
    await exec({ action: 'type', selector: '#name', text: 'Zhang San' });
    await exec({ action: 'type', selector: '#phone', text: '13800000000' });
    await exec({ action: 'click', selector: '#send' });
    const kept = await exec({ action: 'keep_result_page' });
    console.log('[smoke] keep_result_page output:', kept.output);
    await getSurfaceExecutionRuntime().endRun(identity);
    return identity;
  }

  /** 用户 run 认领后绑定的就是 kept 服务键；从真池里取同一个 BrowserService 做读回。 */
  const adoptedService = (conversationId: string, runId: string) => {
    const binding = getManagedBrowserProviderAdapter().getBinding({
      conversationId, runId, agentId: SURFACE_USER_BROWSER_AGENT_ID,
    });
    expect(binding, 'user run must be bound after adopt').toBeTruthy();
    return browserPool.acquire(binding!.serviceKey);
  };

  it('submit -> keep -> run end -> adopt -> result intact -> typed input reads back -> user finish keeps window', async () => {
    const conversationId = 'smoke-conv-kept';
    const links = new UserBrowserLinkService();
    await submitAndKeep(conversationId);

    const keptState = getKeptResultPageHandler(links, { conversationId });
    console.log('[smoke] state after endRun:', JSON.stringify(keptState));
    expect(keptState.state).toBe('kept');
    expect(keptState.url).toContain(origin);
    expect(keptState.title).toBe('Submitted');

    const adopted = await adoptKeptResultPageHandler(links, { conversationId, workspace: process.cwd() });
    console.log('[smoke] adopt snapshot session:', adopted.surfaceSessionId);
    const service = adoptedService(conversationId, adopted.runId);
    expect(service, 'adopted user binding must point at the kept service').toBeTruthy();
    const tab = service!.getActiveTab()!;
    expect(tab.url).toBe(keptState.url);
    expect(await tab.page.locator('#marker').textContent()).toBe('SUBMITTED-OK');

    const box = await tab.page.locator('#note').boundingBox();
    expect(box).toBeTruthy();
    await links.dispatchUserInput({
      conversationId,
      workspace: process.cwd(),
      input: { kind: 'click', x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    });
    await links.dispatchUserInput({
      conversationId,
      workspace: process.cwd(),
      input: { kind: 'insertText', text: 'user typed this' },
    });
    expect(await tab.page.locator('#note').inputValue()).toBe('user typed this');

    await links.end(conversationId, 'user');
    expect(getKeptResultPageHandler(links, { conversationId }).state).toBe('kept');
    expect(service!.isRunning()).toBe(true);
    expect(await tab.page.locator('#note').inputValue()).toBe('user typed this');
  }, TIMEOUT_MS);

  it('closing the browser -> state closed with url retained -> adopt rejects with a plain sentence', async () => {
    const conversationId = 'smoke-conv-closed';
    const links = new UserBrowserLinkService();
    await submitAndKeep(conversationId);
    const before = getKeptResultPageHandler(links, { conversationId });
    expect(before.state).toBe('kept');

    const adopted = await adoptKeptResultPageHandler(links, { conversationId, workspace: process.cwd() });
    const service = adoptedService(conversationId, adopted.runId);
    await service!.close();

    const after = getKeptResultPageHandler(links, { conversationId });
    console.log('[smoke] state after close:', JSON.stringify(after));
    expect(after.state).toBe('closed');
    expect(after.url).toBe(before.url);
    await expect(adoptKeptResultPageHandler(links, { conversationId, workspace: process.cwd() }))
      .rejects.toThrow('这一页的浏览器窗口已经关闭');
  }, TIMEOUT_MS);

  it('killing the kept browser process flips state to closed (url retained) and adopt rejects with a plain sentence', async () => {
    const conversationId = 'smoke-conv-killed';
    const links = new UserBrowserLinkService();
    await submitAndKeep(conversationId);
    const before = getKeptResultPageHandler(links, { conversationId });
    expect(before.state).toBe('kept');

    // 杀掉浏览器进程树（不经 service.close()）：模拟窗口被关/进程崩溃。
    const adopted = await adoptKeptResultPageHandler(links, { conversationId, workspace: process.cwd() });
    const service = adoptedService(conversationId, adopted.runId);
    const userDataDir = service.getSessionState().profileDir;
    const pids = execFileSync('pgrep', ['-f', '--', `--user-data-dir=${userDataDir}`], { encoding: 'utf8' })
      .split('\n').map(Number).filter(Boolean);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }

    await vi.waitFor(() => {
      expect(getKeptResultPageHandler(links, { conversationId }).state).toBe('closed');
    }, { timeout: 15_000 });
    const after = getKeptResultPageHandler(links, { conversationId });
    console.log('[smoke] state after kill -9:', JSON.stringify(after));
    expect(after.url).toBe(before.url);
    const rejection = await adoptKeptResultPageHandler(links, { conversationId, workspace: process.cwd() })
      .then(() => null, (error: Error) => error.message);
    console.log('[smoke] adopt after kill:', rejection);
    expect(rejection).toBe('这一页的浏览器窗口已经关闭，没法接着操作了。可以点「重新打开」恢复网址。');
    expect(rejection).not.toMatch(/[A-Za-z]{4,}/);
  }, TIMEOUT_MS);
});
