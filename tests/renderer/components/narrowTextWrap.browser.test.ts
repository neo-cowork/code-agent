import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';

declare global {
  interface Window {
    __NARROW_READY__?: boolean;
    __NARROW_SET_LANGUAGE__?: (language: string) => void;
  }
}

interface ElementFailure {
  surface: string;
  kind: 'short-label-multi-row' | 'single-char-row' | 'icon-label-split';
  text: string;
  tag: string;
  testId: string | null;
  rows: number;
}

interface SurfaceReport {
  surface: string;
  textElements: number;
  buttons: number;
  iconButtons: number;
  pills: number;
  overflowPx: number;
}

interface Report {
  surfaces: SurfaceReport[];
  failures: ElementFailure[];
}

/** 把 Report 里要在 DOM 里找的关键元素也报出来，证明门真的覆盖到了它们。 */
interface Presence {
  openSessionButtons: number;
  overviewRunHeader: number;
  channelRows: number;
  telegramPrivacyBadge: number;
}

/**
 * Element-agnostic squeeze probe. Runs inside the page: no selector list — every element that
 * owns a non-blank text node inside a [data-surface] container is measured.
 */
function measureSqueezedText(): Report {
  const ROW_TOLERANCE = 3;
  const failures: ElementFailure[] = [];
  const surfaces: SurfaceReport[] = [];

  const rowsOf = (rects: DOMRect[]): number[] => {
    const tops = rects.filter((r) => r.width > 0 && r.height > 0).map((r) => r.top).sort((a, b) => a - b);
    const rows: number[] = [];
    for (const top of tops) {
      if (rows.length === 0 || Math.abs(top - rows[rows.length - 1]) > ROW_TOLERANCE) rows.push(top);
    }
    return rows;
  };

  for (const surface of Array.from(document.querySelectorAll('[data-surface]'))) {
    const name = surface.getAttribute('data-surface') ?? '';
    let textElements = 0;
    let buttons = 0;
    let iconButtons = 0;
    let pills = 0;

    for (const element of Array.from(surface.querySelectorAll('*'))) {
      if (['SCRIPT', 'STYLE', 'SVG', 'PATH', 'TEXTAREA', 'INPUT', 'OPTION'].includes(element.tagName.toUpperCase())) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const testId = element.getAttribute('data-testid');
      const isButton = element.tagName === 'BUTTON';
      if (isButton) buttons += 1;
      if (/\brounded/.test(element.getAttribute('class') ?? '') && (element.textContent ?? '').trim().length > 0) pills += 1;

      const ownTextNodes = Array.from(element.childNodes).filter(
        (node): node is Text => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0,
      );
      if (ownTextNodes.length > 0) {
        textElements += 1;
        const label = ownTextNodes.map((node) => node.textContent ?? '').join('').replace(/\s+/g, ' ').trim();
        const elementRects: DOMRect[] = [];
        const charRows = new Map<number, number>();
        const rowKeys: number[] = [];
        for (const node of ownTextNodes) {
          const data = node.textContent ?? '';
          for (let i = 0; i < data.length; i += 1) {
            if (/\s/.test(data[i])) continue;
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const rect = range.getClientRects()[0];
            if (!rect || rect.width === 0) continue;
            elementRects.push(rect);
            let key = rowKeys.find((k) => Math.abs(k - rect.top) <= ROW_TOLERANCE);
            if (key === undefined) { key = rect.top; rowKeys.push(key); }
            charRows.set(key, (charRows.get(key) ?? 0) + 1);
          }
        }
        const rows = rowsOf(elementRects).length;
        const unspacedShort = label.length <= 12 && !/\s/.test(label);
        if (unspacedShort && rows >= 2) {
          failures.push({ surface: name, kind: 'short-label-multi-row', text: label, tag: element.tagName, testId, rows });
        } else if (label.length > 1 && rows >= 2) {
          const orderedKeys = [...rowKeys].sort((a, b) => a - b);
          const lonely = orderedKeys.filter((key, index) => charRows.get(key) === 1 && (index < orderedKeys.length - 1 || !/\s/.test(label)));
          if (lonely.length > 0) {
            failures.push({ surface: name, kind: 'single-char-row', text: label, tag: element.tagName, testId, rows });
          }
        }
      }

      if (isButton) {
        const svg = element.querySelector('svg');
        const textRects: DOMRect[] = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if ((node.textContent ?? '').trim().length === 0) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          textRects.push(...Array.from(range.getClientRects()));
        }
        if (svg && textRects.length > 0) {
          iconButtons += 1;
          const icon = svg.getBoundingClientRect();
          const iconMid = icon.top + icon.height / 2;
          const textTop = Math.min(...textRects.map((r) => r.top));
          const textBottom = Math.max(...textRects.map((r) => r.bottom));
          if (iconMid < textTop - ROW_TOLERANCE || iconMid > textBottom + ROW_TOLERANCE) {
            failures.push({
              surface: name, kind: 'icon-label-split', text: (element.textContent ?? '').trim(),
              tag: 'BUTTON', testId, rows: 2,
            });
          }
        }
      }
    }
    surfaces.push({
      surface: name, textElements, buttons, iconButtons, pills,
      overflowPx: Math.max(0, surface.scrollWidth - surface.clientWidth),
    });
  }
  return { surfaces, failures };
}

function readPresence(): Presence {
  return {
    openSessionButtons: document.querySelectorAll('[data-testid="cron-exec-detail-open-session"]').length,
    overviewRunHeader: document.querySelectorAll('[data-testid="overview-run-header"]').length,
    channelRows: document.querySelectorAll('[data-testid="channel-account-row"]').length,
    telegramPrivacyBadge: Array.from(document.querySelectorAll('[data-testid="channel-account-status"] span'))
      .filter((el) => el.className.includes('badge-warning')).length,
  };
}

const HARNESS_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="/styles/global.css" />
    <script type="module">
      import { injectIntoGlobalHook } from "/@react-refresh";
      injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="/@vite/client"></script>
  </head>
  <body style="margin:0;background:#09090b;color:white"><div id="root"></div></body>
</html>`;

const MOUNT_SCRIPT = `
const ReactModule = await import('/@id/react');
const React = ReactModule.default || ReactModule;
const ReactDOM = await import('/@id/react-dom/client');
const createRoot = ReactDOM.createRoot || ReactDOM.default?.createRoot;
const { CronExecutionDetail } = await import('/components/features/cron/CronExecutionDetail.tsx');
const { CronExecutionList } = await import('/components/features/cron/CronExecutionList.tsx');
const { CronJobDetail } = await import('/components/features/cron/CronJobDetail.tsx');
const { CronJobList } = await import('/components/features/cron/CronJobList.tsx');
const { OverviewRunHeader } = await import('/components/TaskPanel/OverviewRunHeader.tsx');
const { ChannelsSettings } = await import('/components/features/settings/tabs/ChannelsSettings.tsx');
const { CronRunSessionStatusBar } = await import('/components/features/chat/CronRunSessionStatusBar.tsx');
const { useAppStore } = await import('/stores/appStore.ts');
const { useCronStore } = await import('/stores/cronStore.ts');
const { useSessionStore } = await import('/stores/sessionStore.ts');
const { useTaskStore } = await import('/stores/taskStore.ts');

const base = { jobId: 'job-weekly', runsOn: 'local', scheduledAt: 1000, startedAt: 1000, retryAttempt: 0 };
const interrupted = { ...base, id: 'run-interrupted', sessionId: 'task-panel-session', status: 'interrupted' };
const failed = { ...base, id: 'run-failed', sessionId: 'failed-session', status: 'failed', completedAt: 2000, error: '读取笔记失败' };
const awaiting = { ...base, id: 'run-awaiting', sessionId: 'awaiting-session', status: 'running' };
const completed = { ...base, id: 'run-completed', sessionId: 'completed-session', status: 'completed', completedAt: 3000, result: '已汇总三篇笔记' };
const job = {
  id: 'job-weekly', runsOn: 'local', name: '每周工作日汇总笔记', scheduleType: 'cron',
  schedule: { type: 'cron', expression: '0 9 * * 1-5' },
  action: { type: 'agent', agentType: 'general', prompt: '总结我的三篇笔记' },
  enabled: true, createdAt: 1, updatedAt: 1,
};
const accounts = [
  { id: 'ch-connected', name: '工作 HTTP 接口', type: 'http-api', status: 'connected', enabled: true, createdAt: 1, config: { type: 'http-api', port: 8182, apiKey: 'fixture-key-1' } },
  { id: 'ch-disconnected', name: '备用 HTTP 接口', type: 'http-api', status: 'disconnected', enabled: true, createdAt: 2, config: { type: 'http-api', port: 8183, apiKey: 'fixture-key-2' } },
  { id: 'ch-connecting', name: '测试接口', type: 'http-api', status: 'connecting', enabled: true, createdAt: 3, config: { type: 'http-api', port: 8184, apiKey: 'fixture-key-3' } },
  { id: 'ch-error', name: '出错接口', type: 'http-api', status: 'error', errorMessage: '端口被占用', enabled: true, createdAt: 4, config: { type: 'http-api', port: 8185, apiKey: 'fixture-key-4' } },
  { id: 'ch-telegram', name: '家庭 Telegram 机器人', type: 'telegram', status: 'connected', enabled: true, createdAt: 5, telegramCanReadAllGroupMessages: false, config: { type: 'telegram', botToken: 'fixture-token', groupAccessMode: 'all_members' } },
];
const channelTypes = [{ type: 'http-api', name: 'HTTP API' }, { type: 'telegram', name: 'Telegram' }];

useAppStore.setState({ language: 'zh', pendingPermissionRequest: null, pendingPermissionSessionId: null });
useCronStore.setState({
  jobs: [job], allJobs: [job], jobNamesLoaded: true, selectedJobId: job.id,
  latestExecutions: { [job.id]: failed },
  executionsByJobId: { [job.id]: [failed, interrupted, awaiting, completed] },
});
useSessionStore.setState({
  currentSessionId: 'task-panel-session',
  sessions: [
    { id: 'task-panel-session', title: '汇总三篇笔记', origin: { kind: 'cron', id: job.id, name: job.name }, sourceRunId: interrupted.id, status: 'error', type: 'chat', createdAt: 1, updatedAt: 2, messageCount: 2, turnCount: 1 },
    { id: 'awaiting-session', title: '汇总三篇笔记', origin: { kind: 'cron', id: job.id, name: job.name }, sourceRunId: awaiting.id, status: 'running', type: 'chat', createdAt: 1, updatedAt: 2, messageCount: 1, turnCount: 1 },
  ],
  messages: [
    { id: 'm-user', role: 'user', content: '总结我的三篇笔记', timestamp: 1000 },
    { id: 'm-assistant', role: 'assistant', content: '已中断', timestamp: 1100 },
  ],
  sessionTasks: [],
});
useTaskStore.setState({ sessionStates: { 'task-panel-session': { status: 'error', error: '用户中断' }, 'awaiting-session': { status: 'running' } } });

const invokeDomain = async (_domain, action) => {
  if (action === 'getExecutions') return { success: true, data: [interrupted] };
  if (action === 'listParkedApprovals') return { success: true, data: [] };
  if (action === 'getVoidedApprovalReason') return { success: true, data: null };
  if (action === 'listChannelAccounts') return { success: true, data: accounts };
  if (action === 'getChannelTypes') return { success: true, data: channelTypes };
  return { success: true, data: null };
};
const invoke = async (channel) => {
  const value = String(channel);
  if (value === 'channel:list-accounts') return accounts;
  if (value === 'channel:get-types') return channelTypes;
  return null;
};
window.domainAPI = { invoke: invokeDomain };
window.codeAgentAPI = { invoke, on: () => () => {} };

const h = React.createElement;
const surface = (name, width, child) => h('section', { key: name, 'data-surface': name, style: { width: width + 'px', marginBottom: '12px' } }, child);
const noop = () => {};
const detail = (execution, extra) => h(CronExecutionDetail, { execution, jobName: job.name, ...extra });
createRoot(document.getElementById('root')).render(h('main', { style: { width: '1200px' } },
  surface('run-detail-interrupted', 360, detail(interrupted)),
  surface('run-detail-failed', 360, detail(failed)),
  surface('run-detail-awaiting-approval', 360, detail(awaiting, { awaitingRun: { executionId: awaiting.id, commandPreview: '读取三篇笔记' } })),
  surface('run-detail-completed', 360, detail(completed)),
  surface('run-records-table', 640, h(CronExecutionList, {
    executions: [failed, interrupted, awaiting, completed], selectedExecutionId: null, onSelectExecution: noop,
    jobNameById: { [job.id]: job.name }, runsOnByJobId: { [job.id]: 'local' },
    awaitingByJobId: new Map([[job.id, { commandPreview: '读取三篇笔记' }]]),
  })),
  surface('job-detail', 420, h(CronJobDetail, { job })),
  surface('job-list', 360, h(CronJobList, {})),
  surface('task-panel', 320, h(React.Fragment, null, h(OverviewRunHeader), h(CronRunSessionStatusBar, { sessionId: 'task-panel-session' }))),
  surface('channels-table', 1200, h(ChannelsSettings)),
  surface('channels-table-narrow', 820, h(ChannelsSettings)),
));
window.__NARROW_SET_LANGUAGE__ = (language) => useAppStore.setState({ language });
window.__NARROW_READY__ = true;
`;

async function measure(page: Page): Promise<{ report: Report; presence: Presence }> {
  const report = await page.evaluate<Report>(measureSqueezedText);
  const presence = await page.evaluate<Presence>(readPresence);
  return { report, presence };
}

describe('narrow text wrapping on production surfaces (element-agnostic gate)', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let baseUrl: string;
  let cacheDir: string;

  beforeAll(async () => {
    cacheDir = mkdtempSync(path.join(os.tmpdir(), 'narrow-text-wrap-vite-'));
    server = await createServer({
      configFile: path.resolve(process.cwd(), 'vite.config.ts'),
      cacheDir,
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      plugins: [{
        name: 'narrow-text-wrap-harness',
        configureServer(viteServer) {
          viteServer.middlewares.use('/__narrow-text-wrap.html', (_req, res) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(HARNESS_HTML);
          });
        },
      }],
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite server did not expose a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  });

  it('no text-bearing element renders vertically at 1200x800, zh and en', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    try {
      await page.goto(`${baseUrl}/__narrow-text-wrap.html`, { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ type: 'module', content: MOUNT_SCRIPT });
      await page.waitForFunction(() => window.__NARROW_READY__ === true);
      await page.waitForSelector('[data-testid="channel-account-row"]');
      await page.waitForSelector('[data-testid="overview-run-header"]');
      await page.waitForSelector('[data-testid="cron-exec-detail-open-session"]');

      const allFailures: ElementFailure[] = [];
      for (const language of ['zh', 'en']) {
        await page.evaluate((lang: string): void => {
          if (!window.__NARROW_SET_LANGUAGE__) throw new Error('Missing language hook');
          window.__NARROW_SET_LANGUAGE__(lang);
        }, language);
        await page.waitForTimeout(400);
        const { report, presence } = await measure(page);
        console.log(`narrowTextWrap[${language}] presence ${JSON.stringify(presence)}`);
        for (const surface of report.surfaces) {
          console.log(`narrowTextWrap[${language}] surface=${surface.surface} textElements=${surface.textElements} buttons=${surface.buttons} iconButtons=${surface.iconButtons} pills=${surface.pills} overflowPx=${surface.overflowPx}`);
        }
        for (const failure of report.failures) {
          console.log(`narrowTextWrap[${language}] FAIL ${failure.kind} surface=${failure.surface} <${failure.tag} ${failure.testId ?? ''}> "${failure.text}" rows=${failure.rows}`);
        }
        expect(presence.openSessionButtons).toBeGreaterThan(0);
        expect(presence.overviewRunHeader).toBe(1);
        expect(presence.channelRows).toBeGreaterThanOrEqual(5);
        expect(presence.telegramPrivacyBadge).toBeGreaterThan(0);
        for (const surface of report.surfaces) {
          expect(surface.textElements, `surface ${surface.surface} measured nothing`).toBeGreaterThan(0);
        }
        allFailures.push(...report.failures);
      }
      expect(allFailures).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90000);
});
