// Only the HTTP model boundary is scripted. Cron, orchestration, tools, permissions,
// SQLite and /api/run all execute from a fresh source bundle in an isolated host.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STARTUP_TIMEOUTS } from '../../../src/shared/constants/timeouts';

vi.unmock('better-sqlite3');
const repo = path.resolve(import.meta.dirname, '../../..');
const budget = STARTUP_TIMEOUTS.SLOW_START_NOTICE_MS;
const summary = 'Catalog shipped; invoice totals corrected; customer interviews planned.';
let bundleRoot: string;

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback listener unavailable');
  return address.port;
}

interface ProviderRequest {
  stream?: boolean;
  messages?: unknown[];
  tools?: { function: { name: string } }[];
}

function reply(response: ServerResponse, request: ProviderRequest, writePath?: string): void {
  const toolCalls = writePath ? [{ index: 0, id: 'weekly-report-write', type: 'function',
    function: { name: 'Write', arguments: JSON.stringify({ file_path: writePath, content: summary }) } }] : undefined;
  const message = toolCalls ? { tool_calls: toolCalls } : { content: summary };
  const finish = toolCalls ? 'tool_calls' : 'stop';
  if (!request.stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: finish }] }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
  response.write(`data: ${JSON.stringify({ choices: [{ delta: message }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`);
  response.end('data: [DONE]\n\n');
}

beforeAll(async () => {
  bundleRoot = mkdtempSync(path.join(os.tmpdir(), 'neo-cron-admission-bundle-'));
  await build({
    absWorkingDir: repo, entryPoints: ['src/web/webServer.ts'],
    outfile: path.join(bundleRoot, 'webServer.cjs'), bundle: true,
    platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent',
    alias: { electron: './src/web/electronMock.ts', pdfkit: 'pdfkit/js/pdfkit.standalone.js' },
    external: ['better-sqlite3', 'keytar', 'playwright', 'playwright-core', 'chromium-bidi',
      'sharp', 'node-pty', '@ui-tars/sdk', 'onnxruntime-node'],
  });
}, budget * 6);

afterAll(() => { if (bundleRoot) rmSync(bundleRoot, { recursive: true, force: true }); });

describe('foreground admission during per-minute cron execution', () => {
  it.each(['provider in flight', 'unattended write approval'] as const)(
    'emits its first SSE event within the shared startup budget with cron at %s', async (condition) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'neo-cron-admission-'));
      const home = path.join(root, 'home');
      const data = path.join(home, '.code-agent');
      const workspace = path.join(root, 'workspace');
      for (const dir of [home, data, workspace]) mkdirSync(dir, { recursive: true });
      const marker = `scheduled-weekly-report: ${condition}`;
      let held: { response: ServerResponse; request: ProviderRequest } | undefined;
      let cronModelRequests = 0;
      const provider = createServer((request, response) => {
        void (async () => {
          if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
            response.writeHead(404).end(); return;
          }
          let body = '';
          for await (const chunk of request) body += String(chunk);
          const payload = JSON.parse(body) as ProviderRequest;
          const cron = JSON.stringify(payload.messages).includes(marker)
            && payload.tools?.some((tool) => tool.function.name === 'Write');
          if (cron) {
            cronModelRequests++;
            if (condition === 'provider in flight') { held = { response, request: payload }; return; }
            if (cronModelRequests === 1) {
              reply(response, payload, path.join(workspace, 'weekly-report.md')); return;
            }
          }
          reply(response, payload);
        })().catch(() => { response.writeHead(500).end(); });
      });
      let child: ChildProcess | undefined;
      let db: Database.Database | undefined;
      let serverLog = '';
      const requests = new AbortController();
      try {
        const providerPort = await listen(provider);
        const probe = createServer();
        const port = await listen(probe);
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        const model = { provider: 'custom', model: 'stub-weekly-report' };
        writeFileSync(path.join(data, 'config.json'), JSON.stringify({
          models: {
            default: model.provider, defaultProvider: model.provider,
            providers: { custom: { enabled: true, apiKey: 'local-test-key', model: model.model,
              baseUrl: `http://127.0.0.1:${providerPort}/v1` } },
            routing: { code: model, fast: model, vision: model },
            taskStrategy: { mode: 'manual', defaultProfile: 'main', profiles: { main: model },
              fallback: { enabled: false, allowCrossProvider: false } },
          },
          cloud: { enabled: false, warmupOnInit: false },
          cloudApi: { url: `http://127.0.0.1:${providerPort}` },
          connectors: { enabledNative: [] }, mcp: { servers: [] },
        }));
        writeFileSync(path.join(data, '.env'), '');
        for (const name of ['.last-db-backup', '.last-integrity-check', '.last-vacuum']) {
          writeFileSync(path.join(data, name), String(Date.now()));
        }
        const token = randomUUID();
        const env = { ...process.env, HOME: home, CODE_AGENT_HOME: home, CODE_AGENT_DATA_DIR: data,
          CODE_AGENT_WORKING_DIR: workspace, NODE_PATH: path.join(repo, 'node_modules'),
          NODE_ENV: 'development', VITEST: 'false',
          CODE_AGENT_E2E: '1', CODE_AGENT_E2E_LOCAL_AGENT_MODEL: '0',
          CODE_AGENT_CLI_MODE: 'true', CODE_AGENT_WEB_MODE: 'true',
          CODE_AGENT_ENABLE_DEV_API: 'true', CODE_AGENT_NOTIFICATION_DRY_RUN: '1',
          CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1', CODE_AGENT_SERVICE_MODE: '1',
          CODE_AGENT_WEB_AUTH_TOKEN: token, WEB_HOST: '127.0.0.1', WEB_PORT: String(port),
          CUSTOM_PROVIDER_API_KEY: 'local-test-key', AGENT_NEO_BUNDLED_RUNTIME_ROOT: repo };
        for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
          delete (env as NodeJS.ProcessEnv)[name];
        }
        child = spawn(process.execPath, [path.join(bundleRoot, 'webServer.cjs')], {
          cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.on('data', (chunk: Buffer) => { serverLog += String(chunk); });
        child.stderr?.on('data', (chunk: Buffer) => { serverLog += String(chunk); });
        const base = `http://127.0.0.1:${port}/api`;
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        const post = async <T,>(route: string, body: unknown): Promise<T> => {
          const response = await fetch(base + route, { method: 'POST', headers,
            body: JSON.stringify(body), signal: requests.signal });
          expect(response.ok).toBe(true);
          const result = await response.json() as { success: boolean; data: T };
          expect(result.success, JSON.stringify(result)).toBe(true);
          return result.data;
        };
        await vi.waitFor(async () => {
          const response = await fetch(base + '/health', { headers, signal: AbortSignal.timeout(budget) });
          expect(response.ok, serverLog).toBe(true);
        }, { timeout: budget * 3 });
        const source = await post<{ id: string }>('/sessions', { title: 'Weekly notes', workingDirectory: workspace });
        // Warm the normal host bootstrap, without replacing any runtime or cron entry.
        const warm = await fetch(base + '/run', { method: 'POST', headers,
          body: JSON.stringify({ sessionId: source.id, prompt: 'Summarize this week: catalog shipped.' }),
          signal: requests.signal });
        expect(await warm.text()).toContain('event: agent_complete');
        const foreground = await post<{ id: string }>('/sessions', { title: 'Weekly summary', workingDirectory: workspace });
        const job = await post<{ id: string; enabled: boolean }>('/domain/cron/createJob', { payload: {
          name: 'Every-minute weekly notes', enabled: true, maxRetries: 0,
          scheduleType: 'cron', schedule: { type: 'cron', expression: '* * * * *' },
          action: { type: 'agent', agentType: 'default',
            prompt: `Summarize this week's notes${condition === 'unattended write approval' ? ' in weekly-report.md' : ' in your reply'}. ${marker}` },
          metadata: { sourceSessionId: source.id },
        } });
        expect(job.enabled).toBe(true);
        let cronSettled = false;
        const trigger = post<{ status: string }>('/domain/cron/triggerJob', { payload: { jobId: job.id } })
          .finally(() => { cronSettled = true; });
        // Observe rejection during cleanup as well, so a failing budget cannot leak a promise.
        void trigger.catch(() => undefined);
        db = new Database(path.join(data, 'code-agent.db'), { readonly: true });
        const execution = () => db!.prepare('SELECT session_id, status, completed_at FROM cron_executions WHERE job_id = ? ORDER BY started_at DESC LIMIT 1')
          .get(job.id) as { session_id: string; status: string; completed_at: number | null } | undefined;
        const approval = () => db!.prepare("SELECT id, coordinator_id, payload_json FROM pending_approvals WHERE status = 'pending' AND kind = 'tool_approval'")
          .get() as { id: string; coordinator_id: string; payload_json: string } | undefined;
        await vi.waitFor(() => {
          expect(cronModelRequests).toBeGreaterThan(0);
          expect(execution()?.status).toBe('running');
          if (condition === 'provider in flight') expect(held?.response.destroyed).toBe(false);
          else {
            expect(approval()?.coordinator_id).toBe(execution()?.session_id);
            expect(JSON.parse(approval()!.payload_json)).toMatchObject({ tool: 'Write', startedByAutomation: true });
          }
        }, { timeout: budget * 2 });
        expect(cronSettled).toBe(false);
        const sentAt = performance.now();
        const deadline = AbortSignal.timeout(budget);
        let stream = '';
        try {
          const response = await fetch(base + '/run', { method: 'POST', headers,
            body: JSON.stringify({ sessionId: foreground.id, prompt: 'Summarize the three weekly notes in three bullets.' }), signal: deadline });
          expect(response.ok).toBe(true);
          const reader = response.body!.getReader();
          while (!stream.includes('\n\n')) {
            const next = await reader.read();
            expect(next.done).toBe(false);
            stream += new TextDecoder().decode(next.value);
          }
          const elapsed = performance.now() - sentAt;
          expect(stream).toContain('event: task_start');
          expect(stream).toContain(foreground.id);
          expect(elapsed).toBeLessThan(budget);
          expect(cronSettled).toBe(false);
          expect(execution()).toMatchObject({ status: 'running', completed_at: null });
          if (condition === 'unattended write approval') expect(approval()).toBeDefined();
          process.stdout.write(`[cron-startup] ${condition}: cron=running firstSSE=task_start elapsedMs=${Math.round(elapsed)} budgetMs=${budget} session=${foreground.id}\n`);
          // Drain the real foreground turn before releasing the concurrent cron.
          while (!(await reader.read()).done) { /* consume */ }
          expect(serverLog).toMatch(new RegExp(`sessionId: '${foreground.id}',\\s+phase: 'run_started'`));
        } catch (error) {
          if (deadline.aborted) throw new Error(`Foreground first SSE exceeded shared startup budget (${budget}ms) with cron ${condition}`, { cause: error });
          throw error;
        }
        if (held) reply(held.response, held.request);
        else {
          const request = approval()!;
          await post('/agent/permission-response', [request.id, 'deny', request.coordinator_id]);
        }
        expect((await trigger).status).not.toBe('running');
        expect(cronSettled).toBe(true);
      } finally {
        requests.abort();
        db?.close();
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          process.kill(-child.pid, 'SIGKILL');
          await exited;
        }
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        const artifacts = process.env.NEO_CRON_STARTUP_TEST_OUTPUT;
        if (artifacts) {
          mkdirSync(artifacts, { recursive: true });
          writeFileSync(path.join(artifacts, `${condition.replaceAll(' ', '-')}.log`), serverLog);
        }
        rmSync(root, { recursive: true, force: true });
      }
    }, budget * 6,
  );
});
