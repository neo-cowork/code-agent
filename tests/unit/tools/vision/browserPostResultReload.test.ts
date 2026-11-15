import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrowserTool } from '../../../../src/host/tools/vision/BrowserTool';
import { browserPool, getBrowserService } from '../../../../src/host/services/infra/browserPool';
import type { BrowserService } from '../../../../src/host/services/infra/browserService';
import type { ToolContext } from '../../../../src/host/tools/types';

let server: Server;
let origin: string;
let access: string[] = [];
let service: BrowserService;
let context: ToolContext;
const execute = (action: string, args: Record<string, unknown> = {}) =>
  BrowserTool.execute({ action, engine: 'managed', ...args }, context);

beforeAll(async () => {
  server = createServer((req, res) => {
    access.push(`${req.method} ${req.url}`);
    req.resume();
    const url = new URL(req.url!, origin);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.method === 'POST' && url.searchParams.has('prg')) {
      res.writeHead(303, { Location: '/result' }).end();
    } else if (url.pathname === '/form') {
      res.end(`<form method="post" action="/submit${url.search}"><input name="name"><button>Submit</button></form>`);
    } else {
      res.end('<title>Registration result</title><h1>Registration successful</h1>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP server address missing');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(async () => {
  access = [];
  context = {
    agentId: `post-reload-${randomUUID()}`,
    workingDirectory: process.cwd(),
    requestPermission: async () => true,
    executionIntent: { browserSessionMode: 'managed' },
  };
  service = getBrowserService(context.agentId);
  await service.launch({ provider: 'playwright-bundled', mode: 'headless', profileMode: 'isolated' });
});

afterEach(async () => {
  await browserPool.releaseAgent(context.agentId!);
});

async function submit(query = '') {
  expect((await execute('new_tab', { url: `${origin}/form${query}` })).success).toBe(true);
  const page = service.getActiveTab()!.page;
  await Promise.all([
    page.waitForURL(query.includes('prg') ? `${origin}/result` : `${origin}/submit${query}`),
    execute('click', { selector: 'button' }).then((result) => expect(result.success).toBe(true)),
  ]);
}

function count(entry: string) {
  return access.filter((line) => line === entry).length;
}

describe('Browser execute POST-result reload protection (real Playwright + HTTP)', () => {
  it.each(['reload', 'refresh'])('refuses %s after direct POST without duplicate submission', async (action) => {
    await submit();
    const result = await execute(action);
    process.stdout.write(`${action} server access log: ${JSON.stringify(access)}\n`);
    process.stdout.write(`${action} model error: ${result.error}\n`);
    expect.soft(count('POST /submit')).toBe(1);
    expect.soft(result.success).toBe(false);
    expect(result.error).toContain('This page is the result of a form submission. Reloading would submit the form again');
    expect(result.error).toContain('duplicate signup/order');
    expect(result.error).toContain('Do not reload');
    expect(result.error).toContain('get_content or screenshot');
    expect(result.error).toContain('return to the form page, fill it in, and submit it again');
    expect(result.output ?? '').not.toContain('Page reloaded');
    expect((await execute('get_content')).output).toContain('Registration successful');
  });

  it.each(['reload', 'refresh'])('allows %s after POST/303/GET', async (action) => {
    await submit('?prg');
    const result = await execute(action);
    process.stdout.write(`${action} PRG server access log: ${JSON.stringify(access)}\n`);
    expect(result.success).toBe(true);
    expect(count('POST /submit?prg')).toBe(1);
    expect(count('GET /result')).toBe(2);
  });

  it.each(['reload', 'refresh'])('allows %s on a plain GET page from newTab initial navigation', async (action) => {
    expect((await execute('new_tab', { url: `${origin}/result` })).success).toBe(true);
    expect((await execute(action)).success).toBe(true);
    expect(count('GET /result')).toBe(2);
    expect(access.some((line) => line.startsWith('POST'))).toBe(false);
  });

  it('allows reload on about:blank', async () => {
    expect((await execute('new_tab')).success).toBe(true);
    expect((await execute('reload')).success).toBe(true);
    expect(access).toEqual([]);
  });

  it('blocks after hash changes and logs one WARN with route, tab id, origin only', async () => {
    await submit('?private=secret');
    await service.getActiveTab()!.page.evaluate(() => { location.hash = 'private-hash'; });
    service.logger.clear();
    expect((await execute('reload')).success).toBe(false);
    const warnings = service.logger.getLogs().filter((line) => line.includes('[WARN]'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`browser_action/reload blocked POST result resubmission tab=${service.getActiveTab()!.id} origin=${origin}`);
    expect(warnings[0]).not.toMatch(/secret|private|submit/);
    expect(count('POST /submit?private=secret')).toBe(1);
  });

  it('does not mistake a stale POST URL for the current page', async () => {
    await submit();
    await service.getActiveTab()!.page.evaluate(() => history.replaceState(null, '', '/result'));
    expect((await execute('reload')).success).toBe(true);
    expect(count('POST /submit')).toBe(1);
    expect(count('GET /result')).toBe(1);
  });

  it('does not let subframe navigations or fetch responses overwrite the main-frame POST', async () => {
    await submit();
    await service.getActiveTab()!.page.evaluate(async () => {
      await fetch('/result');
      await new Promise<void>((resolve) => {
        const frame = document.createElement('iframe');
        frame.onload = () => resolve();
        frame.src = '/result';
        document.body.append(frame);
      });
    });
    expect((await execute('reload')).success).toBe(false);
    expect(count('POST /submit')).toBe(1);
  });

  it('keeps tab histories independent and clears POST state after GET navigation', async () => {
    await submit();
    const postTab = service.getActiveTab()!.id;
    expect((await execute('new_tab', { url: `${origin}/result` })).success).toBe(true);
    expect((await execute('reload')).success).toBe(true);
    expect((await execute('reload', { tabId: postTab })).success).toBe(false);
    expect((await execute('navigate', { url: `${origin}/submit`, tabId: postTab })).success).toBe(true);
    expect((await execute('reload', { tabId: postTab })).success).toBe(true);
    expect(count('POST /submit')).toBe(1);
    expect(count('GET /submit')).toBe(2);
  });
});
