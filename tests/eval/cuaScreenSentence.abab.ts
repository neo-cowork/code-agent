#!/usr/bin/env npx tsx
// N-CUA-SCREEN-GUARDS-LADDER-FU1: real GLM A/B — does the model say one plain sentence
// before its first GUI action? Run (needs CUA_SCREEN_SENTENCE_REAL_EVAL=1):
//   env -u HTTPS_PROXY -u HTTP_PROXY CUA_SCREEN_SENTENCE_REAL_EVAL=1 npx tsx tests/eval/cuaScreenSentence.abab.ts
// Subscription quota fallback, only when authorized: append --provider xiaomi.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { config as loadDotenv } from 'dotenv';
const RUNS_A = 10;
const RUNS_B = 3;
const PROMPT_A = '帮我把 Keynote 里这份演示文稿第 3 页的标题改成“2026 年度经营复盘”。';
const PROMPT_B = '给 zhang.wei@example.com 发一封邮件，说明天下午三点的评审会改到四点。';
const LADDER_LINE = /^- Capability ladder:.*\n?/mu;

type Arm = 'NEW' | 'OLD';
interface SchemaLike { name: string; description: string; inputSchema: unknown }
interface Route { provider: string; model: string; baseUrl: string; key: string }

loadDotenv({ path: path.join(process.env.HOME ?? '', '.code-agent', '.env'), quiet: true });

async function fixtures(): Promise<{ prompt: string; schemas: SchemaLike[]; suffix: string }> {
  // Import after the empty data directory is set: no personal prompt overrides.
  const { buildPrompt } = await import('../../src/host/prompts/builder');
  const { MCPToolRegistry } = await import('../../src/host/mcp/mcpToolRegistry');
  const { CUA_SCREEN_LADDER_TOOL_SUFFIX: suffix } = await import('../../src/host/mcp/cuaLadderGuidance');
  const { cuaStatefulComputerUseSchema } = await import('../../src/host/plugins/builtin/computerUse/cuaStatefulComputerUse.schema');
  const { browserActionSchema } = await import('../../src/host/plugins/builtin/browserControl/browserAction.schema');
  const { bashSchema } = await import('../../src/host/tools/modules/shell/bash.schema');
  const { readSchema } = await import('../../src/host/tools/modules/file/read.schema');
  const { mailSchema } = await import('../../src/host/tools/modules/connectors/mail.schema');
  const { calendarSchema } = await import('../../src/host/tools/modules/connectors/calendar.schema');
  delete process.env.CODE_AGENT_CUA_STATE_V2;
  const registry = new MCPToolRegistry();
  registry.tools = ['launch_app', 'get_window_state', 'click'].map((name) => ({
    serverName: 'cua-driver',
    name,
    description: `CUA tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
  }));
  const definitions = registry.getToolDefinitions() as unknown as SchemaLike[];
  process.env.CODE_AGENT_CUA_STATE_V2 = '1';
  return {
    prompt: buildPrompt(), suffix,
    schemas: [bashSchema, readSchema, browserActionSchema, mailSchema, calendarSchema,
      ...definitions, cuaStatefulComputerUseSchema] as SchemaLike[],
  };
}

function toolsForArm(arm: Arm, schemas: SchemaLike[], suffix: string): unknown[] {
  return schemas.map((tool) => {
    const description = arm === 'NEW'
      ? tool.description
      : tool.description.split(` ${suffix}`).join('').split(suffix).join('');
    return { type: 'function', function: { name: tool.name, description, parameters: tool.inputSchema } };
  });
}

function promptForArm(arm: Arm, prompt: string): string {
  if (arm === 'NEW') return prompt;
  if (!LADDER_LINE.test(prompt)) throw new Error('ladder line not found in prompt');
  return prompt.replace(LADDER_LINE, '');
}

async function call(route: Route, messages: unknown[], tools: unknown[]): Promise<Record<string, unknown>> {
  // The domestic GLM route is always direct. The authorized fallback may need
  // an explicit local proxy; URL, TLS verification and credentials stay intact.
  const proxy = route.provider === 'xiaomi' ? process.env.CUA_SCREEN_SENTENCE_PROXY_URL : undefined;
  const address = route.provider === 'xiaomi' ? process.env.CUA_SCREEN_SENTENCE_CONNECT_ADDRESS : undefined;
  // Native curl works with the local TLS route where Node's TLS client fails.
  // Credentials and body go through stdin, never argv, files or error dumps.
  const body = JSON.stringify({ model: route.model, messages, tools, stream: false, max_tokens: 8192 });
  const config = [
    `header = ${JSON.stringify('content-type: application/json')}`,
    `header = ${JSON.stringify(`authorization: Bearer ${route.key}`)}`,
    `data-binary = ${JSON.stringify(body)}`,
  ].join('\n');
  const request = (): Promise<string> => new Promise<string>((resolve, reject) => {
    const child = spawn('curl', [
      '--silent', '--show-error', '--connect-timeout', '60', '--max-time', '180',
      ...(proxy ? ['--proxy', proxy] : ['--noproxy', '*']),
      ...(address ? ['--connect-to', `${new URL(route.baseUrl).hostname}:443:${address}:443`] : []),
      '--config', '-', '--write-out', '\n%{http_code}', `${route.baseUrl}/chat/completions`,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    process.stderr.write(`curl pid=${child.pid ?? 'unknown'} provider=${route.provider}\n`);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`curl exit ${code}: ${stderr}`));
    });
    child.stdin.end(`${config}\n`);
  });
  let wire = '';
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try { wire = await request(); break; } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only retry TLS setup failures: no HTTP request/model choice was sent.
      if (attempt === 6 || !/SSL connection timeout|SSL_connect/u.test(message)) throw error;
      process.stderr.write(`TLS setup retry ${attempt}/6: ${message}\n`);
    }
  }
  const split = wire.lastIndexOf('\n');
  const status = wire.slice(split + 1);
  const response = wire.slice(0, split);
  if (status !== '200') throw new Error(`HTTP ${status}: ${response.slice(0, 300)}`);
  return JSON.parse(response) as Record<string, unknown>;
}

function summarize(response: Record<string, unknown>): Record<string, unknown> {
  const choices = response.choices as Array<{ message: Record<string, unknown> }>;
  const message = choices[0].message;
  const calls = (message.tool_calls as Array<{ function: { name: string } }> | undefined) ?? [];
  return {
    content: (message.content as string | null) ?? '',
    reasoning_content: (message.reasoning_content as string | undefined) ?? '',
    firstTool: calls[0]?.function.name ?? '(none)',
    // Keep the unmodified provider response, including arguments: Bash can drive
    // a GUI, or only read Apple Events data. Tool name alone cannot distinguish it.
    response,
  };
}

async function main(): Promise<void> {
  if (process.env.CUA_SCREEN_SENTENCE_REAL_EVAL !== '1') throw new Error('Set CUA_SCREEN_SENTENCE_REAL_EVAL=1');
  const providerIndex = process.argv.indexOf('--provider');
  const provider = providerIndex < 0 ? 'zhipu' : process.argv[providerIndex + 1];
  if (provider !== 'zhipu' && provider !== 'xiaomi') throw new Error('Only zhipu or authorized xiaomi subscription fallback');
  const route: Route = provider === 'zhipu'
    ? { provider, model: 'glm-5.3', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', key: process.env.ZHIPU_CODING_API_KEY ?? '' }
    : { provider, model: process.env.XIAOMI_MODEL || 'mimo-v2.6-flash', baseUrl: (process.env.XIAOMI_API_URL ?? '').replace(/\/+$/u, ''), key: process.env.XIAOMI_API_KEY ?? '' };
  if (!route.key || !route.baseUrl) throw new Error(`${provider} subscription route/key missing`);
  for (const proxy of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) delete process.env[proxy];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cua-sentence-eval-'));
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_CUA_STATE_V2 = '1';
  try {
    const { prompt, schemas, suffix } = await fixtures();
    const arms = (['NEW', 'OLD'] as const).map((arm) => ({
      arm, prompt: promptForArm(arm, prompt), tools: toolsForArm(arm, schemas, suffix),
    }));
    const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    let out: Record<string, unknown> = {
      provider, model: route.model, endpoint: route.baseUrl, maxTokens: 8192,
      fallbackProxyHost: process.env.CUA_SCREEN_SENTENCE_PROXY_URL
        ? new URL(process.env.CUA_SCREEN_SENTENCE_PROXY_URL).host : null,
      promptA: PROMPT_A, promptB: PROMPT_B,
      // These are the actual model-visible inputs (no credentials, no user overrides).
      arms: arms.map((arm) => ({ ...arm, promptHash: hash(arm.prompt), toolsHash: hash(arm.tools) })),
      A: [], B: [],
    };
    const output = process.env.CUA_SCREEN_SENTENCE_OUTPUT;
    if (output && fs.existsSync(output)) {
      if (!process.argv.includes('--resume')) throw new Error('Output exists; use --resume or a fresh output path');
      const previous = JSON.parse(fs.readFileSync(output, 'utf8')) as Record<string, unknown>;
      if (previous.model !== out.model || previous.endpoint !== out.endpoint || hash(previous.arms) !== hash(out.arms)) {
        throw new Error('Resume inputs differ; preserve this round and use a fresh output path');
      }
      out = previous;
    }
    out.transportSessions ??= [];
    (out.transportSessions as unknown[]).push({
      started: new Date().toISOString(),
      fallbackProxyHost: process.env.CUA_SCREEN_SENTENCE_PROXY_URL
        ? new URL(process.env.CUA_SCREEN_SENTENCE_PROXY_URL).host : null,
      fallbackConnectAddress: process.env.CUA_SCREEN_SENTENCE_CONNECT_ADDRESS ?? null,
    });
    const save = (): void => {
      if (process.env.CUA_SCREEN_SENTENCE_OUTPUT) {
        fs.writeFileSync(process.env.CUA_SCREEN_SENTENCE_OUTPUT, `${JSON.stringify(out, null, 2)}\n`);
      }
    };
    save();

    for (let i = 0; i < RUNS_A; i += 1) {
      for (const { arm, prompt: system, tools } of arms) {
        if ((out.A as Array<{ arm: Arm; run: number }>).some((row) => row.arm === arm && row.run === i + 1)) continue;
        const message = await call(route,
          [{ role: 'system', content: system }, { role: 'user', content: PROMPT_A }], tools,
        );
        (out.A as unknown[]).push({ arm, run: i + 1, ...summarize(message) });
        save();
        process.stderr.write(`A ${arm} ${i + 1}/${RUNS_A} captured\n`);
      }
    }
    const unavailable = 'Mail connector: unavailable\nMail connector is not configured in this runtime.\nCapabilities: none';
    for (let i = 0; i < RUNS_B; i += 1) {
      if ((out.B as Array<{ run: number }>).some((row) => row.run === i + 1)) continue;
      const message = await call(route, [
        { role: 'system', content: arms[0].prompt },
        { role: 'user', content: PROMPT_B },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_mail_status', type: 'function', function: { name: 'mail', arguments: '{"action":"get_status"}' } }] },
        { role: 'tool', tool_call_id: 'call_mail_status', content: unavailable },
      ], arms[0].tools);
      (out.B as unknown[]).push({ arm: 'NEW', run: i + 1, ...summarize(message) });
      save();
      process.stderr.write(`B NEW ${i + 1}/${RUNS_B} captured\n`);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
