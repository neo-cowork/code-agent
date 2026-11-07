import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { ToolContext } from '../../../../src/host/tools/types';
import { startFixture } from '../../../fixtures/browser-doomloop/server.mjs';
import { browserPool } from '../../../../src/host/services/infra/browserPool';
import { browserActionTool } from '../../../../src/host/tools/vision/browserAction';

vi.mock('../../../../src/host/services/cloud/featureFlagService', () => ({
  isComputerUseEnabled: () => true,
}));

const AGENT_ID = 'unit-selector-fill-fast-fail';
const TEST_TIMEOUT_MS = 60_000;

function makeToolContext(): ToolContext {
  return {
    workingDirectory: '/tmp',
    requestPermission: async () => true,
    sessionId: 'selector-fill-session',
    agentId: AGENT_ID,
    executionIntent: {
      browserSessionMode: 'managed',
      preferBrowserSession: true,
      allowBrowserAutomation: true,
    },
  } as ToolContext;
}

describe('browser_action selector fill fast-fail & consecutive retry stop-loss', () => {
  let server: Server | null = null;
  let baseUrl = '';
  const ctx = makeToolContext();

  beforeAll(async () => {
    const started = await startFixture(0);
    server = started.server;
    baseUrl = `http://127.0.0.1:${started.port}`;
    const svc = browserPool.acquire(AGENT_ID);
    await svc.launch({ mode: 'headless', profileMode: 'isolated', provider: 'playwright-bundled' });
    await svc.newTab(`${baseUrl}/wiki-search`);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browserPool.releaseAgent(AGENT_ID).catch(() => undefined);
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }, TEST_TIMEOUT_MS);

  it(
    'fails within ~5 s on a CSS media-query hidden input, names "found but not visible" + innerWidth + narrow/compact layout, and points to get_dom_snapshot/targetRef/navigate',
    async () => {
      await browserActionTool.execute({ action: 'navigate', url: `${baseUrl}/wiki-search` }, ctx);
      await browserActionTool.execute({ action: 'set_viewport', width: 900, height: 720 }, ctx);

      const t0 = Date.now();
      const res = await browserActionTool.execute(
        { action: 'type', selector: '#searchInput', text: 'Tauri' },
        ctx,
      );
      const elapsedMs = Date.now() - t0;

      console.log(`[timing] hidden #searchInput fill failed in ${elapsedMs}ms: ${res.error}`);
      expect(res.success).toBe(false);
      expect(elapsedMs).toBeLessThan(6_000);
      expect(res.error).toContain('element found but not visible');
      expect(res.error).toContain('innerWidth=900px');
      expect(res.error).toContain('the page may be showing a narrow/compact layout');
      expect(res.error).toContain('get_dom_snapshot');
      expect(res.error).toContain('targetRef');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails within ~5 s on a missing selector and names "element not found"',
    async () => {
      await browserActionTool.execute({ action: 'navigate', url: `${baseUrl}/wiki-search` }, ctx);

      const t0 = Date.now();
      const res = await browserActionTool.execute(
        { action: 'type', selector: '#doesNotExistInput', text: 'Tauri' },
        ctx,
      );
      const elapsedMs = Date.now() - t0;

      console.log(`[timing] missing #doesNotExistInput fill failed in ${elapsedMs}ms: ${res.error}`);
      expect(res.success).toBe(false);
      expect(elapsedMs).toBeLessThan(6_000);
      expect(res.error).toContain('element not found');
      expect(res.error).toContain('get_dom_snapshot');
      expect(res.error).toContain('targetRef');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'identifies duplicate selectors ("found several") and non-editable elements ("not editable")',
    async () => {
      await browserActionTool.execute({ action: 'navigate', url: `${baseUrl}/wiki-search` }, ctx);

      const dupRes = await browserActionTool.execute(
        { action: 'type', selector: '.dup-input', text: 'Tauri' },
        ctx,
      );
      expect(dupRes.success).toBe(false);
      expect(dupRes.error).toContain('found several');
      expect(dupRes.error).toContain('get_dom_snapshot');

      const roRes = await browserActionTool.execute(
        { action: 'type', selector: '#readonlyInput', text: 'Tauri' },
        ctx,
      );
      expect(roRes.success).toBe(false);
      expect(roRes.error).toContain('not editable');
      expect(roRes.error).toContain('get_dom_snapshot');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops the 3rd consecutive call on the same failing selector immediately (<200 ms) and resets on different selector, success, or navigation',
    async () => {
      await browserActionTool.execute({ action: 'navigate', url: `${baseUrl}/wiki-search` }, ctx);
      await browserActionTool.execute({ action: 'set_viewport', width: 900, height: 720 }, ctx);

      // 1st failure on #readonlyInput (fast failure because readonly fails immediately in Playwright or within timeout)
      const fail1 = await browserActionTool.execute(
        { action: 'type', selector: '#readonlyInput', text: 'attempt-1' },
        ctx,
      );
      expect(fail1.success).toBe(false);

      // 2nd failure on #readonlyInput
      const fail2 = await browserActionTool.execute(
        { action: 'type', selector: '#readonlyInput', text: 'attempt-2' },
        ctx,
      );
      expect(fail2.success).toBe(false);

      // 3rd call on #readonlyInput -> immediate stop-loss without hitting Playwright
      const t3 = Date.now();
      const fail3 = await browserActionTool.execute(
        { action: 'type', selector: '#readonlyInput', text: 'attempt-3' },
        ctx,
      );
      const elapsed3 = Date.now() - t3;
      console.log(`[timing] 3rd consecutive call on #readonlyInput returned in ${elapsed3}ms: ${fail3.error}`);
      expect(fail3.success).toBe(false);
      expect(elapsed3).toBeLessThan(200);
      expect(fail3.error).toContain('Do not retry this selector');
      expect(fail3.error).toContain('get_dom_snapshot');
      expect(fail3.error).toContain('targetRef');

      // Reset via success on a visible input (at 1500px #searchInput is visible!)
      await browserActionTool.execute({ action: 'set_viewport', width: 1500, height: 720 }, ctx);
      const ok = await browserActionTool.execute(
        { action: 'type', selector: '#searchInput', text: 'Tauri' },
        ctx,
      );
      expect(ok.success).toBe(true);
      console.log('[reset] visible selector fill succeeded and reset the failure streak');

      // After success, #readonlyInput starts from 1 again (not blocked by 3rd-call guard)
      const afterSuccess = await browserActionTool.execute(
        { action: 'type', selector: '#readonlyInput', text: 'attempt-after-success' },
        ctx,
      );
      expect(afterSuccess.success).toBe(false);
      expect(afterSuccess.error).not.toContain('Do not retry this selector');

      // Fail a 2nd time on #readonlyInput so streak is 2, then navigate -> resets counter
      await browserActionTool.execute(
        { action: 'type', selector: '#readonlyInput', text: 'attempt-before-nav' },
        ctx,
      );
      await browserActionTool.execute({ action: 'navigate', url: `${baseUrl}/wiki-search` }, ctx);
      const afterNav = await browserActionTool.execute(
        { action: 'type', selector: '#readonlyInput', text: 'attempt-after-nav' },
        ctx,
      );
      expect(afterNav.success).toBe(false);
      expect(afterNav.error).not.toContain('Do not retry this selector');
      console.log('[reset] navigation reset the selector failure streak');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'also applies fast-fail and consecutive selector stop-loss to fill_form',
    async () => {
      await browserActionTool.execute({ action: 'navigate', url: `${baseUrl}/wiki-search` }, ctx);
      await browserActionTool.execute({ action: 'set_viewport', width: 900, height: 720 }, ctx);

      const t0 = Date.now();
      const res1 = await browserActionTool.execute(
        { action: 'fill_form', formData: { '#searchInput': 'Tauri' } },
        ctx,
      );
      const elapsed1 = Date.now() - t0;
      expect(res1.success).toBe(false);
      expect(elapsed1).toBeLessThan(6_000);
      expect(res1.error).toContain('element found but not visible');

      // 2nd failure via fill_form on #readonlyInput (after resetting selector to #readonlyInput)
      await browserActionTool.execute(
        { action: 'fill_form', formData: { '#readonlyInput': 'a' } },
        ctx,
      );
      await browserActionTool.execute(
        { action: 'fill_form', formData: { '#readonlyInput': 'b' } },
        ctx,
      );
      const res3 = await browserActionTool.execute(
        { action: 'fill_form', formData: { '#readonlyInput': 'c' } },
        ctx,
      );
      expect(res3.success).toBe(false);
      expect(res3.error).toContain('Do not retry this selector');
      console.log(`[timing] fill_form 3rd same-selector call stopped: ${res3.error}`);
    },
    TEST_TIMEOUT_MS,
  );
});
