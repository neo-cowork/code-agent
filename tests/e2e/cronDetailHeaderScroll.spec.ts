// ============================================================================
// Event-triggered automation detail: tall-header scroll geometry.
//
// The job is created through the real cron domain route. The decision ledger is
// seeded directly because there is no product write API for historical decision
// rows; reads still use the real cron route and renderer component.
// ============================================================================

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from './fixtures/axeTest';

test.setTimeout(120_000);

const require_ = createRequire(import.meta.url);
const SHOT_DIR = path.join(process.cwd(), 'test-results');
const SCREENSHOT_DIR = process.env.CRON_DETAIL_SCREENSHOT_DIR || SHOT_DIR;
const UNFIXED_CAPTURE = process.env.CRON_DETAIL_UNFIXED === '1';
const DATA_DIR = process.env.CODE_AGENT_E2E_DATA_DIR
  || path.join(os.tmpdir(), `code-agent-e2e-data-${process.env.E2E_WEB_PORT || '8180'}`);

interface Box { x: number; y: number; width: number; height: number }

interface GeometrySnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  overflowY: string;
  root: Box;
  clip: Box;
  mode: Box;
  lastDecision: Box;
  advanced: Box;
  header: Box;
  runs: Box;
}

async function waitForAppReady(page: Page): Promise<void> {
  const index = await page.request.get('/');
  const match = /window\.__CODE_AGENT_TOKEN__=("(?:[^"\\]|\\.)*")/.exec(await index.text());
  const headers: Record<string, string> = match ? { authorization: `Bearer ${JSON.parse(match[1]) as string}` } : {};
  const current = await page.request.get('/api/settings', { headers });
  const body = await current.json() as { data?: Record<string, unknown> };
  const settings = body.data ?? body;
  const updated = await page.request.put('/api/settings', { headers, data: { ...settings, ui: { language: 'zh' } } });
  expect(updated.ok(), 'set fixture language before loading the page').toBe(true);
  const ssePromise = page.waitForResponse((response) => response.url().includes('/api/events'), { timeout: 20_000 });
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;
  for (const name of ['信任并加载', '跳过，稍后在设置里配置', '返回应用']) {
    const button = page.getByRole('button', { name }).first();
    await button.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await expect(button).toBeHidden({ timeout: 10_000 });
    }
  }
  await expect(page.getByTestId('sidebar-capability-zone')).toBeVisible({ timeout: 15_000 });
}

async function cronDomain(page: Page, action: string, payload: unknown): Promise<unknown> {
  const { origin } = new URL(page.url());
  const token = await page.evaluate(() => (window as unknown as { __CODE_AGENT_TOKEN__?: string }).__CODE_AGENT_TOKEN__);
  const response = await page.request.post(`${origin}/api/domain/cron/${action}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    data: { payload },
  });
  const body = await response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (!response.ok() || body.success === false) {
    throw new Error(`cron/${action}: ${response.status()} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function addFeishuFixtureAccount(page: Page): Promise<string> {
  const account = await page.evaluate(async () => {
    const bridge = (window.codeAgentAPI ?? window.electronAPI) as {
      invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    } | undefined;
    if (!bridge) throw new Error('command bridge unavailable');
    return bridge.invoke('channel:add-account', {
      name: 'E2E scroll geometry Feishu',
      type: 'feishu',
      config: {
        type: 'feishu',
        appId: 'e2e-scroll-geometry-app',
        appSecret: 'e2e-scroll-geometry-secret',
        useWebSocket: false,
      },
    });
  }) as { id?: string } | null;
  if (!account?.id) throw new Error(`failed to add Feishu fixture account: ${JSON.stringify(account)}`);
  return account.id;
}

async function seedEventJob(page: Page, jobName: string, accountId: string): Promise<string> {
  const job = await cronDomain(page, 'createJob', {
    name: jobName,
    description: '用于短窗口滚动几何验收。'.repeat(96),
    scheduleType: 'event',
    schedule: {
      type: 'event',
      source: 'channel',
      accountId,
      chatId: 'e2e-scroll-geometry-chat',
      eventName: 'message',
    },
    runsOn: 'local',
    enabled: true,
    maxRetries: 0,
    maxRunBudget: 0.5,
    action: { type: 'agent', agentType: 'default', prompt: '收到群消息后判断是否需要回复' },
  }) as { id?: string };
  if (!job.id) throw new Error(`createJob returned no id: ${JSON.stringify(job)}`);
  return job.id;
}

function seedWouldActDecisions(jobId: string): void {
  const dbPath = path.join(DATA_DIR, 'code-agent.db');
  expect(fs.existsSync(dbPath), `missing E2E database: ${dbPath}`).toBe(true);
  const Database = require_('better-sqlite3');
  const db = new Database(dbPath);
  try {
    const insert = db.prepare(`
      INSERT INTO cron_event_decisions
      (id, job_id, kind, event_id, decision, reason, run_id, matched_rule, tool, target, summary, created_at)
      VALUES (?, ?, 'action', NULL, 'would_act', ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (let index = 0; index < 3; index += 1) {
      insert.run(
        `e2e-scroll-decision-${jobId}-${index}`,
        jobId,
        `观察档拦下第 ${index + 1} 条对外回复`,
        `e2e-scroll-run-${index}`,
        'channel message · selected Feishu group',
        'channel_reply',
        'e2e-scroll-geometry-chat',
        `本会回复第 ${index + 1} 条消息，但没有实际发送`,
        now + index,
      );
    }
  } finally {
    db.close();
  }
}

function fullyInside(inner: Box, outer: Box): boolean {
  return inner.y >= outer.y - 1 && inner.y + inner.height <= outer.y + outer.height + 1;
}

async function snapshot(detailRoot: Locator): Promise<GeometrySnapshot> {
  return detailRoot.evaluate((root) => {
    const required = (element: Element | null, label: string): Element => {
      if (!element) throw new Error(`missing ${label}`);
      return element;
    };
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const advanced = required(root.querySelector('[data-testid="cron-detail-advanced"]'), 'advanced fold');
    const header = required(advanced.parentElement, 'header');
    const runs = required(header.nextElementSibling, 'runs block');
    const mode = required(root.querySelector('[data-testid="cron-switch-to-auto"]'), 'execution-mode switch');
    const rows = root.querySelectorAll('[data-testid="cron-event-would-act-row"]');
    const lastDecision = required(rows.item(rows.length - 1), 'last would-act decision');
    const clip = required(root.closest('[data-testid="cron-center-scroll"]'), 'page scroller');
    return {
      scrollTop: clip.scrollTop,
      scrollHeight: clip.scrollHeight,
      clientHeight: clip.clientHeight,
      overflowY: getComputedStyle(root).overflowY,
      root: box(root),
      clip: box(clip),
      mode: box(mode),
      lastDecision: box(lastDecision),
      advanced: box(advanced),
      header: box(header),
      runs: box(runs),
    };
  });
}

async function setDetailScroll(detailRoot: Locator, top: number): Promise<void> {
  await detailRoot.evaluate((element, nextTop) => {
    const pageScroll = element.closest('[data-testid="cron-center-scroll"]');
    pageScroll?.scrollTo({ top: nextTop, behavior: 'instant' });
  }, top);
  await detailRoot.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function assertDetailScrollable(
  page: Page,
  jobName: string,
  viewport: { width: number; height: number },
  tag: string,
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.getByTestId('sidebar-capability-automation').click();
  await expect(page.getByTestId('cron-center-panel')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: new RegExp(jobName) }).click();

  const advanced = page.getByTestId('cron-detail-advanced');
  const decisions = page.getByTestId('cron-event-decisions');
  const wouldActRows = page.getByTestId('cron-event-would-act-row');
  await expect(advanced).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('region', { name: '检查群消息是否连通' })).toBeVisible({ timeout: 10_000 });
  await expect(decisions).toBeVisible();
  await expect(page.getByTestId('cron-write-scope-panel')).toBeVisible();
  await expect(wouldActRows).toHaveCount(3, { timeout: 10_000 });

  await advanced.locator('summary').click();
  await expect(advanced).toHaveAttribute('open', '');

  const header = advanced.locator('..');
  const detailRoot = header.locator('..');
  const runs = header.locator('xpath=following-sibling::div[1]');
  await setDetailScroll(detailRoot, 0);

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `cron-detail-header-${tag}-before.png`) });

  await setDetailScroll(detailRoot, 0);
  const initial = await snapshot(detailRoot);
  console.log(`[${tag}] initial ${JSON.stringify(initial)}`);
  if (UNFIXED_CAPTURE) {
    const requestedScrollTop = await detailRoot.evaluate((element) => {
      const scroller = element.closest('[data-testid="cron-center-scroll"]')!;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
      return scroller.scrollHeight;
    });
    const attempted = await snapshot(detailRoot);
    console.log(`[${tag}] unfixed-scroll-attempt requestedScrollTop=${requestedScrollTop} ${JSON.stringify(attempted)}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `cron-detail-header-${tag}-before-scroll-attempt.png`) });
  }
  expect(initial.scrollTop).toBe(0);
  expect(initial.overflowY, 'detail content must flow into the page scroller').toBe('visible');
  expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight);
  expect(fullyInside(initial.mode, initial.clip), 'mode switch starts clipped below the detail viewport').toBe(false);
  expect(fullyInside(initial.lastDecision, initial.clip), 'last would-act row starts clipped below the detail viewport').toBe(false);

  const minimumScrollForLastRow = initial.lastDecision.y + initial.lastDecision.height
    - initial.clip.y - initial.clip.height + initial.scrollTop;
  const maximumScrollKeepingModeVisible = initial.mode.y - initial.clip.y + initial.scrollTop;
  const decisionScrollTop = Math.round(
    (minimumScrollForLastRow + maximumScrollKeepingModeVisible) / 2,
  );
  await setDetailScroll(detailRoot, decisionScrollTop);
  const revealed = await snapshot(detailRoot);
  console.log(`[${tag}] decisions-revealed ${JSON.stringify(revealed)}`);
  expect(revealed.scrollTop).toBeGreaterThan(0);
  expect(fullyInside(revealed.mode, revealed.clip), 'mode switch is fully visible after detail scroll').toBe(true);
  expect(fullyInside(revealed.lastDecision, revealed.clip), 'last would-act row is fully visible after detail scroll').toBe(true);
  await setDetailScroll(detailRoot, decisionScrollTop);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `cron-detail-header-${tag}-after.png`) });

  await advanced.scrollIntoViewIfNeeded();
  await detailRoot.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const bottom = await snapshot(detailRoot);
  console.log(`[${tag}] header-bottom ${JSON.stringify(bottom)}`);
  expect(fullyInside(bottom.advanced, bottom.clip), 'the expanded advanced fold is reachable').toBe(true);

  expect(bottom.runs.height, 'runs block keeps a non-zero minimum height').toBeGreaterThanOrEqual(200);
  expect(bottom.runs.y, 'runs block follows the header without overlap')
    .toBeGreaterThanOrEqual(bottom.header.y + bottom.header.height - 1);
  await runs.scrollIntoViewIfNeeded();
  await detailRoot.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const runsVisible = await snapshot(detailRoot);
  console.log(`[${tag}] runs-visible ${JSON.stringify(runsVisible)}`);
  expect(fullyInside(runsVisible.runs, runsVisible.clip), 'runs block remains visible in the same scroll container').toBe(true);
}

for (const viewport of [
  { width: 1440, height: 900, tag: '1440x900' },
  { width: 1280, height: 720, tag: '1280x720' },
] as const) {
  test(`event job detail header scrolls at ${viewport.tag}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await waitForAppReady(page);
    const accountId = await addFeishuFixtureAccount(page);
    const jobName = `滚动几何夹具 ${viewport.tag} ${Date.now()}`;
    const jobId = await seedEventJob(page, jobName, accountId);
    seedWouldActDecisions(jobId);
    // createJob's in-memory fingerprint is normalized once by the 5 s DB
    // reconciliation tick. Let that one-time refresh finish before measuring so
    // it cannot remount the detail pane between a scroll and its screenshot.
    await page.waitForTimeout(5_500);
    await assertDetailScrollable(page, jobName, viewport, viewport.tag);
  });
}
