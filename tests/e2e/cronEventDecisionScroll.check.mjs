// Run against a restarted, SQLite-seeded web build (no mocks or model calls):
// CRON_SCROLL_URL=http://127.0.0.1:<port> CRON_SCROLL_SHOTS=<output> node tests/e2e/cronEventDecisionScroll.check.mjs
// Fixtures: 周报收件箱整理 (3 would_act + 7 other decisions), 新周报收件箱 (0).
// CRON_SCROLL_CAPTURE_BEFORE=1 records the old geometry without accepting it.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { chromium } from 'playwright';

const baseURL = process.env.CRON_SCROLL_URL;
assert(baseURL, 'Set CRON_SCROLL_URL to the isolated web build');
const output = process.env.CRON_SCROLL_SHOTS || 'test-results/cron-event-scroll';
const captureBefore = process.env.CRON_SCROLL_CAPTURE_BEFORE === '1';
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let checks = 0;

async function measure(page) {
  return page.getByTestId('cron-event-decision-row').last().evaluate((row) => {
    const nodes = [];
    for (let node = row.parentElement; node; node = node.parentElement) {
      const style = globalThis.getComputedStyle(node);
      nodes.push({
        tag: node.tagName, testId: node.getAttribute('data-testid'), className: node.className,
        overflowY: style.overflowY, clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight, scrollTop: node.scrollTop,
        active: /^(auto|scroll)$/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1,
      });
    }
    const rect = row.getBoundingClientRect();
    return { ancestors: nodes, row: { top: rect.top, bottom: rect.bottom, height: rect.height }, viewport: globalThis.innerHeight };
  });
}

async function shot(page, name, target) {
  assert(await target.isVisible(), `screenshot target missing: ${name}`);
  console.log(`ASSERT screenshot ${name}: target visible, text=${(await target.innerText()).slice(0, 120)}`);
  await page.screenshot({ path: path.join(output, `${name}.png`) });
  await fs.writeFile(path.join(output, `${name}.txt`), await page.locator('body').innerText());
}

async function setLanguage(request, token, language) {
  const headers = { Authorization: `Bearer ${token}` };
  const response = await request.get(`${baseURL}/api/settings`, { headers });
  assert(response.ok(), `settings get: ${response.status()}`);
  const body = await response.json();
  const settings = body.data ?? body;
  const updated = await request.put(`${baseURL}/api/settings`, {
    headers, data: { ...settings, ui: { ...settings.ui, language } },
  });
  assert(updated.ok(), `settings set: ${updated.status()}`);
  console.log(`settings API before page load: language=${language} HTTP ${updated.status()}`);
}

async function open(page) {
  await page.goto(`${baseURL}/?open=automation`);
  const skip = page.getByRole('button', { name: /^(跳过，稍后在设置里配置|Skip for now, set up later in Settings)$/ });
  await skip.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
  if (await skip.isVisible()) await skip.click();
  const close = page.getByRole('button', { name: /^(关闭|Close|返回应用|Back to app)$/ }).first();
  if (await close.isVisible()) await close.click();
  await page.getByTestId('cron-center-panel').waitFor();
  await page.getByRole('button', { name: /周报收件箱整理/ }).click();
  await page.getByTestId('cron-event-decision-row').nth(6).waitFor();
  assert.equal(await page.getByTestId('cron-event-would-act-row').count(), 3);
  assert.equal(await page.getByTestId('cron-event-decision-row').count(), 7);
}

try {
  // neo-realrun service mode intentionally never exposes its bearer in HTML.
  // Authenticate the isolated browser requests with the orchestrator's token.
  const state = process.env.CRON_SCROLL_STATE
    ? JSON.parse(await fs.readFile(process.env.CRON_SCROLL_STATE, 'utf8')) : null;
  const context = await browser.newContext({ deviceScaleFactor: 1,
    ...(state ? { extraHTTPHeaders: { Authorization: `Bearer ${state.token}` } } : {}),
  });
  const index = await context.request.get(baseURL);
  const tokenMatch = /window\.__CODE_AGENT_TOKEN__=("(?:[^"\\]|\\.)*")/.exec(await index.text());
  assert(state || tokenMatch, 'supply CRON_SCROLL_STATE for a neo-realrun service');
  const token = state?.token ?? JSON.parse(tokenMatch[1]);
  for (const [language, width, height] of [['zh', 1440, 900], ['zh', 1280, 720], ['en', 1280, 720]]) {
    await setLanguage(context.request, token, language);
    const page = await context.newPage();
    await page.setViewportSize({ width, height });
    await open(page);
    const tag = `${captureBefore ? 'before' : 'after'}-${language}-${width}x${height}`;
    const layout = await page.getByTestId('cron-center-scroll').evaluate((node) => {
      const grid = [...node.querySelectorAll('div')].find((el) => el.classList.contains('flex-[1_0_420px]'));
      const featured = node.querySelector('[data-testid="cron-featured-templates"]');
      const status = node.querySelector('[data-testid="cron-status-bar"]');
      const jobList = grid.firstElementChild.querySelector('.overflow-y-auto');
      return { gridHeight: grid.clientHeight, listOverflowY: globalThis.getComputedStyle(jobList).overflowY,
        statusBeforeTemplates: status.getBoundingClientRect().bottom <= featured.getBoundingClientRect().top,
        templatesBeforeGrid: featured.getBoundingClientRect().bottom <= grid.getBoundingClientRect().top };
    });
    assert(layout.gridHeight >= 420 && layout.listOverflowY === 'auto');
    assert(layout.statusBeforeTemplates && layout.templatesBeforeGrid, 'keep the status/templates/workbench order');
    console.log(`${tag} preserved layout ${JSON.stringify(layout)}`);
    const scroller = page.getByTestId('cron-center-scroll');
    const rows = page.locator('[data-testid="cron-event-would-act-row"], [data-testid="cron-event-decision-row"]');
    // Start at the workbench without locator auto-scrolling into an inner list.
    await scroller.evaluate((node) => {
      const grid = [...node.querySelectorAll('div')].find((el) => el.classList.contains('flex-[1_0_420px]'));
      node.scrollTop = grid.offsetTop - node.offsetTop;
    });
    const initial = await measure(page);
    console.log(`${tag} initial ${JSON.stringify(initial)}`);
    await shot(page, `${tag}-initial`, page.getByTestId('cron-event-decisions'));
    // Focus a real detail action; PageDown must propagate to the page scroller.
    await page.getByRole('button', { name: /^(编辑|Edit)$/ }).focus();
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(350);
    const key = await measure(page);
    console.log(`${tag} PageDown ${JSON.stringify(key)}`);
    const rect = await page.getByTestId('cron-event-decisions').boundingBox();
    assert(rect);
    await page.mouse.move(rect.x + Math.min(rect.width / 2, 150), Math.min(height - 40, Math.max(130, rect.y + 100)));
    await page.mouse.wheel(0, 450);
    await page.waitForTimeout(350);
    const wheel = await measure(page);
    console.log(`${tag} wheel ${JSON.stringify(wheel)}`);
    await shot(page, `${tag}-pagedown-wheel`, page.getByTestId('cron-event-decisions'));
    if (!captureBefore) {
      const active = initial.ancestors.filter((node) => node.active);
      assert.deepEqual(active.map((node) => node.testId), ['cron-center-scroll'], 'detail must have exactly one active scroll ancestor');
      const top = (snapshot) => snapshot.ancestors.find((node) => node.testId === 'cron-center-scroll').scrollTop;
      assert(top(key) > top(initial), 'PageDown must scroll the page beyond the first record');
      assert(top(wheel) > top(key), 'wheel over decisions must scroll the page');
      for (let i = 0; i < await rows.count(); i++) {
        await rows.nth(i).scrollIntoViewIfNeeded();
        const visible = await rows.nth(i).evaluate((node) => {
          const r = node.getBoundingClientRect();
          const clip = node.closest('[data-testid="cron-center-scroll"]').getBoundingClientRect();
          return r.top >= clip.top - 1 && r.bottom <= Math.min(clip.bottom, globalThis.innerHeight) + 1;
        });
        assert(visible, `record ${i + 1} must be completely reachable`);
      }
      console.log(`${tag} PASS all ${await rows.count()} decision records completely reachable`);
    }
    // Page-only bottom scroll: must expose the final record without touching nested containers.
    await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const bottom = await measure(page);
    console.log(`${tag} bottom ${JSON.stringify(bottom)}`);
    if (!captureBefore) assert(bottom.row.top >= 0 && bottom.row.bottom <= height, 'last decision fully visible at page bottom');
    await shot(page, `${tag}-bottom`, page.getByTestId('cron-event-decision-row').last());
    if (!captureBefore) {
      await page.getByRole('button', { name: /新周报收件箱/ }).click();
      await page.waitForFunction(() => globalThis.document.querySelectorAll('[data-testid="cron-event-decision-row"]').length === 0);
      await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      const empty = await page.getByTestId('cron-event-decisions').evaluate((node) => ({ height: node.getBoundingClientRect().height, text: node.textContent }));
      assert(empty.height < 180, 'empty ledger must collapse rather than reserve the populated list height');
      assert(empty.text.includes(language === 'zh' ? '还没有事件进来。' : 'No events yet.'), 'empty-state copy must be present');
      const compact = await page.getByTestId('cron-job-detail').evaluate((node) => {
        const header = node.firstElementChild;
        const history = header.nextElementSibling;
        const list = node.parentElement.previousElementSibling.querySelector('.overflow-y-auto');
        return { height: node.clientHeight, contentHeight: header.getBoundingClientRect().height + history.getBoundingClientRect().height,
          listClientHeight: list.clientHeight, listScrollHeight: list.scrollHeight, listOverflowY: globalThis.getComputedStyle(list).overflowY };
      });
      assert(compact.height <= Math.max(420, compact.contentHeight) + 1, 'job list must not stretch empty detail with blank space');
      assert.equal(compact.listOverflowY, 'auto', 'job list keeps its independent scroll');
      console.log(`${tag} compact empty detail ${JSON.stringify(compact)}`);
      console.log(`${tag} zero decisions ${JSON.stringify(empty)}`);
      await shot(page, `${tag}-zero-decisions`, page.getByTestId('cron-event-decisions'));
    }
    await page.close();
    checks++;
  }
  await context.close();
  console.log(`${captureBefore ? 'CAPTURE' : 'PASS'} cron event scroll: ${checks} viewport/language cases, 0 failures`);
} finally {
  await browser.close();
}
