import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';

describe('narrow text wrapping production surfaces', () => {
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
            res.end(`<!doctype html>
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
</html>`);
          });
        },
      }],
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite server did not expose a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  });

  it('mounts production components and rejects one-character-per-line text at 1200x800', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    try {
      await page.goto(`${baseUrl}/__narrow-text-wrap.html`, { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({
        type: 'module',
        content: `
          const ReactModule = await import('/@id/react');
          const React = ReactModule.default || ReactModule;
          const ReactDOM = await import('/@id/react-dom/client');
          const createRoot = ReactDOM.createRoot || ReactDOM.default?.createRoot;
          const { CronExecutionDetail } = await import('/components/features/cron/CronExecutionDetail.tsx');
          const { CronJobDetail } = await import('/components/features/cron/CronJobDetail.tsx');
          const { OverviewRunHeader } = await import('/components/TaskPanel/OverviewRunHeader.tsx');
          const { ChannelsSettings } = await import('/components/features/settings/tabs/ChannelsSettings.tsx');
          const { CronRunSessionStatusBar } = await import('/components/features/chat/CronRunSessionStatusBar.tsx');
          const { Badge } = await import('/components/primitives/Badge.tsx');
          const { useAppStore } = await import('/stores/appStore.ts');
          const { useCronStore } = await import('/stores/cronStore.ts');
          const { useSessionStore } = await import('/stores/sessionStore.ts');
          const { useTaskStore } = await import('/stores/taskStore.ts');

          const interrupted = {
            id: 'execution-interrupted', jobId: 'job-narrow', sessionId: 'task-panel-session',
            runsOn: 'local', status: 'interrupted', scheduledAt: 1000, startedAt: 1000,
            retryAttempt: 0,
          };
          const awaiting = {
            id: 'execution-awaiting', jobId: 'job-narrow', sessionId: 'awaiting-session', runsOn: 'local', status: 'running',
            scheduledAt: 1000, startedAt: 1000, retryAttempt: 0,
          };
          const failed = {
            id: 'execution-failed', jobId: 'job-narrow', runsOn: 'local', status: 'failed',
            scheduledAt: 1000, startedAt: 1000, completedAt: 2000, retryAttempt: 0,
            error: 'failed fixture',
          };
          const job = {
            id: 'job-narrow', runsOn: 'local', name: '每周摘要', scheduleType: 'cron',
            schedule: { type: 'cron', expression: '0 9 * * 1' },
            action: { type: 'agent', agentType: 'general', prompt: '总结三篇笔记' },
            enabled: true, createdAt: 1, updatedAt: 1,
          };
          const accounts = [
            { id: 'channel-connected', name: '已连接账号', type: 'http-api', status: 'connected', enabled: true, createdAt: 1, config: { type: 'http-api', port: 8182, apiKey: 'fixture-key' } },
            { id: 'channel-disconnected', name: '未连接账号', type: 'http-api', status: 'disconnected', enabled: true, createdAt: 2, config: { type: 'http-api', port: 8183, apiKey: 'fixture-key-2' } },
          ];
          const channelTypes = [{ type: 'http-api', name: 'HTTP API' }];

          useAppStore.setState({ language: 'zh', pendingPermissionRequest: null, pendingPermissionSessionId: null });
          useCronStore.setState({
            jobs: [job], allJobs: [job], jobNamesLoaded: true,
            latestExecutions: { [job.id]: failed },
            executionsByJobId: { [job.id]: [failed] },
          });
          useSessionStore.setState({
            currentSessionId: 'task-panel-session',
            sessions: [
              { id: 'task-panel-session', title: '处理中断任务', origin: { kind: 'cron', id: 'job-narrow', name: '每周摘要' }, sourceRunId: interrupted.id, status: 'error', type: 'chat', createdAt: 1, updatedAt: 2, messageCount: 2, turnCount: 1 },
              { id: 'awaiting-session', title: '等待批准任务', origin: { kind: 'cron', id: 'job-narrow', name: '每周摘要' }, sourceRunId: awaiting.id, status: 'running', type: 'chat', createdAt: 1, updatedAt: 2, messageCount: 1, turnCount: 1 },
            ],
            messages: [
              { id: 'narrow-user', role: 'user', content: '检查任务是否中断', timestamp: 1000 },
              { id: 'narrow-assistant', role: 'assistant', content: '已中断', timestamp: 1100 },
            ],
            sessionTasks: [],
          });
          useTaskStore.setState({
            sessionStates: {
              'task-panel-session': { status: 'error', error: '用户中断' },
              'awaiting-session': { status: 'running' },
            },
          });

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

          const rootElement = document.getElementById('root');
          if (!rootElement || !createRoot) throw new Error('Missing harness root');
          const panel = (name, style, child) => React.createElement('section', { 'data-surface': name, style }, child);
          createRoot(rootElement).render(React.createElement('main', { style: { width: '1200px' } },
            panel('run-detail-interrupted', { width: '360px' }, React.createElement(React.Fragment, null,
              React.createElement(CronExecutionDetail, { execution: interrupted, jobName: '每周摘要' }),
              React.createElement('div', { 'data-testid': 'narrow-primitive-sensor', style: { width: '40px', overflow: 'hidden' } },
                React.createElement(Badge, { className: 'w-full max-w-[40px] text-xs' }, '已中断'),
              ),
            )),
            panel('run-detail-awaiting', { width: '360px' }, React.createElement(CronExecutionDetail, { execution: awaiting, jobName: '每周摘要', awaitingRun: { executionId: awaiting.id, commandPreview: '读取三篇笔记' } })),
            panel('run-detail-failed', { width: '360px' }, React.createElement(CronExecutionDetail, { execution: failed, jobName: '每周摘要' })),
            panel('job-detail-failed', { width: '420px' }, React.createElement(CronJobDetail, { job })),
            panel('task-panel-interrupted', { width: '320px' }, React.createElement(React.Fragment, null,
              React.createElement(OverviewRunHeader),
              React.createElement(CronRunSessionStatusBar, { sessionId: 'task-panel-session' }),
            )),
            panel('channels', { width: '1200px' }, React.createElement(ChannelsSettings)),
          ));
          window.__NARROW_SET_LANGUAGE__ = (language) => useAppStore.setState({ language });
          window.__NARROW_TEXT_WRAP_READY__ = true;
        `,
      });
      await page.waitForFunction(() => window.__NARROW_TEXT_WRAP_READY__ === true);
      await page.waitForSelector('[data-testid="channel-account-row"]');
      await page.waitForSelector('[data-testid="cron-exec-detail-status-interrupted"]');
      await page.waitForSelector('[data-testid="cron-detail-status"]');
      await page.waitForSelector('[data-testid="cron-run-status-text"]');
      await page.waitForSelector('[data-testid="overview-run-header"]');

      const measurements = await page.evaluate(() => {
        const lineCount = (element) => {
          const childNodes = Array.from(element.childNodes);
          const tops = (childNodes.length > 0 ? childNodes : [element])
            .flatMap((node) => {
              const range = document.createRange();
              if (node === element) range.selectNodeContents(element);
              else range.selectNodeContents(node);
              return Array.from(range.getClientRects()).map((rect) => rect.top);
            })
            .sort((a, b) => a - b);
          if (tops.length === 0) return 0;
          const style = getComputedStyle(element);
          const fontSize = Number.parseFloat(style.fontSize) || 16;
          const parsedLineHeight = Number.parseFloat(style.lineHeight);
          const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : fontSize * 1.2;
          const rowTolerance = Math.max(2, lineHeight * 0.5);
          let rows = 1;
          for (let index = 1; index < tops.length; index += 1) {
            if (tops[index] - tops[index - 1] > rowTolerance) rows += 1;
          }
          return rows;
        };
        const exact = (root, text) => {
          const candidates = Array.from(root.querySelectorAll('*')).filter((element) => element.textContent?.trim() === text);
          return candidates.find((element) => element.tagName === 'SPAN') || candidates[0];
        };
        const panel = (name) => document.querySelector('[data-surface="' + name + '"]');
        const read = (name, selectors) => {
          const root = panel(name);
          if (!root) throw new Error('Missing surface ' + name);
          const result = {};
          for (const [label, selector] of Object.entries(selectors)) {
            const element = root.querySelector(selector);
            if (!element) throw new Error('Missing selector ' + selector + ' on ' + name);
            result[label] = lineCount(element);
          }
          return result;
        };
        const channels = panel('channels');
        const channelLabels = ['断开', '编辑', '删除', '连接'];
        const channelCounts = Object.fromEntries(channelLabels.map((label) => {
          const element = exact(channels, label);
          if (!element) throw new Error('Missing channel action ' + label);
          return [label, lineCount(element)];
        }));
        const sweep = Object.fromEntries(Array.from(document.querySelectorAll('[data-surface]')).map((surface) => {
          const candidates = Array.from(surface.querySelectorAll('button, [class*="rounded"]')).filter((element) => {
            const text = element.textContent?.trim() || '';
            if (!text || text.length > 8 || /\s/.test(text)) return false;
            const classTokens = Array.from(element.classList);
            const roundedPill = classTokens.some((token) => token === 'rounded' || token === 'rounded-full' || token === 'rounded-md');
            if (element.tagName !== 'BUTTON' && !roundedPill) return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          const details = candidates.map((element) => ({
            text: element.textContent?.trim() || '',
            testId: element.getAttribute('data-testid'),
            lines: lineCount(element),
          }));
          return [surface.getAttribute('data-surface'), {
            count: details.length,
            failures: details.filter((item) => item.lines !== 1),
          }];
        }));
        return {
          runDetailInterrupted: read('run-detail-interrupted', { '已中断': '[data-testid="cron-exec-detail-status-interrupted"]' }),
          runDetailAwaiting: read('run-detail-awaiting', { '等你批准': '[data-testid="cron-exec-detail-awaiting-approval"]', '打开会话': '[data-testid="cron-exec-detail-open-session"]' }),
          runDetailFailed: read('run-detail-failed', { '失败': '[data-testid="cron-exec-detail-status-failed"]' }),
          jobDetailFailed: read('job-detail-failed', { '失败': '[data-testid="cron-detail-status"]' }),
          taskPanelInterrupted: read('task-panel-interrupted', { '已中断': '[data-testid="cron-run-status-text"]' }),
          overviewRunHeader: Boolean(document.querySelector('[data-testid="overview-run-header"]')),
          channels: channelCounts,
          primitiveSensor: lineCount(document.querySelector('[data-testid="narrow-primitive-sensor"] span')),
          overflow: Object.fromEntries(Array.from(document.querySelectorAll('[data-surface]')).map((element) => [
            element.getAttribute('data-surface'), { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth },
          ])),
          sweep,
        };
      });
      console.log('narrowTextWrap measurements', JSON.stringify(measurements));
      await page.evaluate(() => {
        window.__NARROW_SET_LANGUAGE__('en');
      });
      await page.waitForFunction(() => document.querySelector('[data-surface="channels"]')?.textContent?.includes('Disconnect'));
      const channelsEnglish = await page.evaluate(() => {
        const root = document.querySelector('[data-surface="channels"]');
        if (!root) throw new Error('Missing channels surface');
        const lineCount = (element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top * 10) / 10)).size;
        };
        const labels = ['Disconnect', 'Edit', 'Delete', 'Connect'];
        return Object.fromEntries(labels.map((label) => {
          const element = Array.from(root.querySelectorAll('span')).find((candidate) => candidate.textContent?.trim() === label);
          if (!element) throw new Error('Missing English channel action ' + label);
          return [label, lineCount(element)];
        }));
      });
      console.log('narrowTextWrap English channel measurements', JSON.stringify(channelsEnglish));
      for (const surface of Object.values(measurements)) {
        if (surface && typeof surface === 'object' && 'scrollWidth' in surface) {
          expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth + 1);
        }
      }
      const lines = [
        ...Object.values(measurements.runDetailInterrupted),
        ...Object.values(measurements.runDetailAwaiting),
        ...Object.values(measurements.runDetailFailed),
        ...Object.values(measurements.jobDetailFailed),
        ...Object.values(measurements.taskPanelInterrupted),
        ...Object.values(measurements.channels),
        ...Object.values(channelsEnglish),
        measurements.primitiveSensor,
      ];
      expect(lines.every((count) => count === 1)).toBe(true);
      const sweepFailures = Object.values(measurements.sweep)
        .flatMap((surface) => surface.failures);
      expect(sweepFailures).toEqual([]);

      await page.evaluate(() => {
        const fixture = document.createElement('div');
        fixture.style.width = '40px';
        fixture.innerHTML = '<span class="rounded-full px-2.5 py-1 text-xs">已中断</span>';
        fixture.dataset.narrowMutation = 'true';
        document.body.appendChild(fixture);
      });
      const mutationLines = await page.locator('[data-narrow-mutation] span').evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top * 10) / 10)).size;
      });
      expect(mutationLines).toBeGreaterThan(1);
    } finally {
      await page.close();
    }
  }, 30000);
});
