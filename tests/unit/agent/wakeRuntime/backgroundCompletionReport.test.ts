import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

// Protocol fixture only: TaskManager, run registry, AgentLoop, finalizer and completion
// delivery all run in the real web host. No executor or finalizer replacement.
const root = process.cwd();
const output = mkdtempSync(path.join(tmpdir(), 'neo-wake-runtime-'));
const token = randomUUID();
let host: ChildProcess;
let provider: Server;
let base: string;
let log = '';
let capture = '';
let abort: AbortController;
let recording: Promise<void>;
let mode: 'report' | 'failure' = 'report';
let wakeRequests = 0;
const wakeToolCounts: number[] = [];
const children = new Set<string>();
const pendingApprovals = new Set<string>();

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

async function api(route: string, body?: unknown) {
  const response = await fetch(`${base}/api/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response;
}

beforeAll(async () => {
  provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const messages = body.messages as Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>;
    const text = JSON.stringify(messages);
    const users = messages.filter((message) => message.role === 'user');
    const wake = text.includes('<subagent_notification>');
    const child = !wake && text.includes('FIXTURE_CHILD_ONLY');
    let content = 'started';
    let call: { name: string; arguments: string } | undefined;
    if (!body.stream) content = '后台任务';
    else if (wake) {
      wakeRequests++;
      wakeToolCounts.push(body.tools?.length ?? 0);
      if (mode === 'failure') {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'fixture wake unavailable', type: 'invalid_request_error' } }));
        return;
      }
      content = '后台任务已结束，已按你的决定处理。';
    } else if (child) {
      // The real child executes this tool and parks on the real approval island.
      const key = text.match(/fixture-case-[\w-]+/)?.[0] ?? 'fixture-case';
      if (!children.has(key)) {
        children.add(key);
        call = { name: 'Bash', arguments: JSON.stringify({ command: 'pwd' }) };
      } else content = '后台工作已结束。';
    } else if (!messages.some((message) => message.tool_calls?.length)) {
      const key = JSON.stringify(users).match(/fixture-case-[\w-]+/)?.[0] ?? 'fixture-case';
      call = { name: 'spawn_agent', arguments: JSON.stringify({ role: 'coder', task: `FIXTURE_CHILD_ONLY ${key}: 请检查当前工作目录并汇报。`, run_in_background: true }) };
    }
    const message = call
      ? { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: call }] }
      : { role: 'assistant', content };
    response.writeHead(200, { 'Content-Type': body.stream ? 'text/event-stream' : 'application/json' });
    const common = { id: randomUUID(), model: body.model, created: 1 };
    if (!body.stream) {
      response.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      return;
    }
    const delta = call
      ? { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: call }] }
      : { role: 'assistant', content };
    response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  const providerPort = await listen(provider);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const home = path.join(output, 'home');
  const data = path.join(home, '.code-agent');
  const workspace = path.join(output, 'workspace');
  mkdirSync(data, { recursive: true });
  mkdirSync(workspace);
  const model = 'gpt-4o';
  const route = { provider: 'openai', model };
  writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    models: { default: 'openai', defaultProvider: 'openai', providers: { openai: { enabled: true, apiKey: 'fixture', baseUrl: `http://127.0.0.1:${providerPort}/v1`, model, models: { [model]: { enabled: true, supportsTool: true } } } }, routing: { code: route, fast: route }, taskStrategy: { mode: 'manual', defaultProfile: 'main', profiles: { main: route }, fallback: { enabled: false } } },
    cloud: { enabled: false }, connectors: { enabledNative: [] }, mcp: { servers: [] },
  }));
  for (const file of ['.last-db-backup', '.last-integrity-check', '.last-vacuum']) writeFileSync(path.join(data, file), String(Date.now()));
  const bundle = path.join(output, 'webServer.cjs');
  await build({ entryPoints: [path.join(root, 'src/web/webServer.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: bundle, logLevel: 'silent',
    external: ['better-sqlite3', 'keytar', 'playwright', 'playwright-core', 'chromium-bidi', 'sharp', 'node-pty', '@ui-tars/sdk', 'onnxruntime-node'],
    alias: { electron: path.join(root, 'src/web/electronMock.ts'), pdfkit: 'pdfkit/js/pdfkit.standalone.js' },
  });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODE_AGENT_HOME: home, CODE_AGENT_DATA_DIR: data, CODE_AGENT_WORKING_DIR: workspace,
    CODE_AGENT_WEB_MODE: 'true', CODE_AGENT_CLI_MODE: 'true', CODE_AGENT_SERVICE_MODE: '1', CODE_AGENT_WEB_AUTH_TOKEN: token,
    CODE_AGENT_ENABLE_DEV_API: 'true', CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1', AGENT_NEO_BUNDLED_RUNTIME_ROOT: root,
    NODE_PATH: path.join(root, 'node_modules'), WEB_HOST: '127.0.0.1', WEB_PORT: String(port) };
  delete env.VITEST;
  env.NODE_ENV = 'development';
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
  host = spawn(process.execPath, [bundle], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout?.on('data', (chunk) => { log += chunk; });
  host.stderr?.on('data', (chunk) => { log += chunk; });
  base = `http://127.0.0.1:${port}`;
  await vi.waitFor(async () => { if (host.exitCode !== null) throw new Error(log.slice(-5000)); expect((await api('health')).status).toBe(200); }, { timeout: 30000 }).catch((error) => { console.error(log.slice(-5000)); throw error; });
  abort = new AbortController();
  recording = (async () => {
    const response = await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
    if (!response.body) throw new Error('Missing event stream');
    for await (const chunk of response.body) capture += Buffer.from(chunk).toString();
  })().catch((error) => { if (error.name !== 'AbortError') throw error; });
}, 60000);

afterAll(async () => {
  abort?.abort();
  await recording;
  if (host && host.exitCode === null) {
    const exited = new Promise<void>((resolve) => host.once('exit', () => resolve()));
    host.kill('SIGTERM');
    await exited;
  }
  await new Promise<void>((resolve) => provider?.close(() => resolve()));
  writeFileSync(path.join(output, 'server.log'), log);
  writeFileSync(path.join(output, 'events.sse'), capture);
});

function events(raw: string): Array<{ type: string; sessionId?: string; data: Record<string, unknown> }> {
  return raw.split('\n').filter((line) => line.startsWith('data: ')).flatMap((line) => {
    const parsed = JSON.parse(line.slice(6));
    return parsed.channel === 'agent:event' ? [parsed.args] : [];
  });
}

describe('idle background report through the production host', () => {
  it.each(['allow', 'deny', 'failure'] as const)('%s: one report, no generic failure event', async (variant) => {
    mode = variant === 'failure' ? 'failure' : 'report';
    const from = capture.length;
    const beforeRequests = wakeRequests;
    const stream = await api('run', { project: path.join(output, 'workspace'), prompt: `fixture-case-${variant}: 派出后台助手检查工作目录，只回复已启动。` });
    const runTextPromise = stream.text();
    await expect.poll(async () => {
      const pending = events(capture.slice(from)).filter((event) => event.type === 'permission_request');
      for (const event of pending) {
        const requestId = String(event.data.id);
        if (pendingApprovals.has(requestId)) continue;
        pendingApprovals.add(requestId);
        await api('agent/permission-response', [requestId, variant === 'deny' ? 'deny' : 'allow', event.sessionId ?? event.data.sessionId]);
      }
      return wakeRequests > beforeRequests;
    }, { timeout: 30000, interval: 50 }).toBe(true);
    await runTextPromise;
    await expect.poll(() => events(capture.slice(from)).filter((event) => event.type === 'agent_complete').length, { timeout: 30000 }).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const received = events(capture.slice(from));
    expect(log).toContain('Executing task for session');
    expect(received.filter((event) => event.type === 'error')).toEqual([]);
    expect(wakeRequests - beforeRequests).toBe(1);
    if (variant === 'failure') {
      expect(received.filter((event) => event.type === 'message' && (event.data.metadata as { backgroundWakeFailed?: unknown })?.backgroundWakeFailed)).toHaveLength(1);
    } else {
      expect(received.filter((event) => event.type === 'message' && event.data.content === '后台任务已结束，已按你的决定处理。')).toHaveLength(1);
      expect(wakeToolCounts.at(-1)).toBe(0);
      expect(received.filter((event) => event.type === 'message' && (event.data.metadata as { backgroundWakeFailed?: unknown })?.backgroundWakeFailed)).toEqual([]);
    }
  }, 60000);
});
