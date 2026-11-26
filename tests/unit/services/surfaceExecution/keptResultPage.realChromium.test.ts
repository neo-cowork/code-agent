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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { MANAGED_BROWSER_DEFAULT_LEASE_TTL_MS } from '../../../../src/host/services/infra/browser/managedBrowserHelpers';
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
    await new Promise<void>((resolve) => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(browserPool.listAgents().map((key) => browserPool.releaseAgent(key)));
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

  it.each(['session switch', 'still bound'] as const)(
    'expires a kept page 30 minutes after the last user input (%s)',
    async (variant) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const keptAt = Date.now();
      const conversationId = 'smoke-conv-idle';
      const input = { conversationId, workspace: process.cwd() };
      const links = new UserBrowserLinkService();
      await submitAndKeep(conversationId);
      const adopted = await adoptKeptResultPageHandler(links, input);
      const service = adoptedService(conversationId, adopted.runId);
      const expiryLog = vi.spyOn(service.logger, 'log');
      const close = vi.spyOn(service, 'close');
      const note = service.getActiveTab()!.page.locator('#note');
      const box = (await note.boundingBox())!;
      await links.dispatchUserInput({
        ...input,
        input: { kind: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2 },
      });

      await vi.advanceTimersByTimeAsync((18 * 60 + 20) * 1000);
      const inputAt = Date.now();
      await links.dispatchUserInput({ ...input, input: { kind: 'insertText', text: 'a note' } });
      expect(await note.inputValue()).toBe('a note');
      const expiresAtMs = service.getSessionState().lease?.expiresAtMs;
      console.log('[smoke] kept lease after user input:', { variant, keptAt, inputAt, expiresAtMs });
      if (variant === 'session switch') await links.end(conversationId, 'session-switch');

      const keptState = () => getKeptResultPageHandler(links, input).state;
      await vi.advanceTimersByTimeAsync((11 * 60 + 40) * 1000);
      await close.mock.results.at(-1)?.value;
      expect.soft(keptState(), 'kept at T0+30:00').toBe('kept');
      await vi.advanceTimersByTimeAsync(18 * 60 * 1000);
      expect.soft(keptState(), 'kept at T0+48:00').toBe('kept');
      expect.soft(expiresAtMs, 'expiry after user input').toBe(inputAt + 30 * 60 * 1000);

      // A bound window keeps its in-use protection until the user leaves.
      if (variant === 'still bound') await links.end(conversationId, 'session-switch');
      await vi.advanceTimersByTimeAsync(21 * 1000);
      await close.mock.results.at(-1)?.value;
      expect.soft(keptState(), 'closed at T0+48:21').toBe('closed');
      expect(expiryLog).toHaveBeenCalledWith('WARN', expect.stringContaining('Managed browser lease expired'));
    },
    TIMEOUT_MS,
  );

  it.each(['history', 'open', 'adopt'] as const)(
    '%s renews the existing user binding while viewport updates do not',
    async (action) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const conversationId = 'smoke-conv-activity';
      const input = { conversationId, workspace: process.cwd() };
      const links = new UserBrowserLinkService();
      await submitAndKeep(conversationId);
      const adopted = await adoptKeptResultPageHandler(links, input);
      const service = adoptedService(conversationId, adopted.runId);

      await vi.advanceTimersByTimeAsync(10_000);
      if (action === 'history') await links.history({ ...input, action: 'back' });
      else if (action === 'open') await links.open({ ...input, url: origin });
      else await adoptKeptResultPageHandler(links, input);
      const expectedExpiry = Date.now() + MANAGED_BROWSER_DEFAULT_LEASE_TTL_MS;
      expect(service.getSessionState().lease?.expiresAtMs).toBe(expectedExpiry);

      await vi.advanceTimersByTimeAsync(10_000);
      await links.setViewport({ ...input, width: 900, height: 650 });
      expect(service.getSessionState().lease?.expiresAtMs).toBe(expectedExpiry);
      await links.end(conversationId, 'session-switch');
    },
    TIMEOUT_MS,
  );

  it.each(['close_tab', 'native page close'])('keeps the result until the last managed page closes via %s', async (closePath) => {
    const conversationId = `smoke-conv-last-tab-${closePath}`;
    const links = new UserBrowserLinkService();
    const { identity, exec } = startAgentRun(conversationId);
    try {
      await exec({ action: 'navigate', url: origin });
      await exec({ action: 'keep_result_page' });
      const service = getManagedBrowserProviderAdapter().getBrowserService(identity);
      const resultTab = service.getActiveTab()!;
      const context = resultTab.page.context();
      const poll = () => getKeptResultPageHandler(links, { conversationId });
      expect(poll().state).toBe('kept');

      await exec({ action: 'new_tab', url: origin });
      expect(service.listTabs()).toHaveLength(2);
      await exec({ action: 'close_tab', tabId: service.getActiveTab()!.id });
      const afterNonLast = poll();
      console.log('[smoke] poll after non-last close:', JSON.stringify(afterNonLast));
      expect(afterNonLast.state).toBe('kept');

      if (closePath === 'close_tab') {
        await exec({ action: 'close_tab', tabId: resultTab.id });
      } else {
        await resultTab.page.close();
      }
      console.log('[smoke] Chromium pages after last managed close:', JSON.stringify(
        context.pages().filter((page) => !page.isClosed()).map((page) => page.url()),
      ));
      const afterLast = poll();
      console.log('[smoke] poll after last close:', JSON.stringify(afterLast));
      expect(afterLast.state).toBe('closed');
      expect(afterLast.url).toBe(afterNonLast.url);
    } finally {
      await getSurfaceExecutionRuntime().endRun(identity);
    }
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
