#!/usr/bin/env npx tsx
// N-CUA-SCREEN-GUARDS-LADDER-FU1: real GLM A/B — does the model say one plain sentence
// before its first screen action? Run (needs CUA_SCREEN_SENTENCE_REAL_EVAL=1):
//   env -u HTTPS_PROXY -u HTTP_PROXY CUA_SCREEN_SENTENCE_REAL_EVAL=1 npx tsx tests/eval/cuaScreenSentence.abab.ts
import path from 'node:path';
import process from 'node:process';
import { config as loadDotenv } from 'dotenv';
import { buildPrompt } from '../../src/host/prompts/builder';
import { MCPToolRegistry } from '../../src/host/mcp/mcpToolRegistry';
import { CUA_SCREEN_LADDER_TOOL_SUFFIX } from '../../src/host/mcp/cuaLadderGuidance';
import { cuaStatefulComputerUseSchema } from '../../src/host/plugins/builtin/computerUse/cuaStatefulComputerUse.schema';
import { browserActionSchema } from '../../src/host/plugins/builtin/browserControl/browserAction.schema';
import { bashSchema } from '../../src/host/tools/modules/shell/bash.schema';
import { readSchema } from '../../src/host/tools/modules/file/read.schema';
import { mailSchema } from '../../src/host/tools/modules/connectors/mail.schema';
import { calendarSchema } from '../../src/host/tools/modules/connectors/calendar.schema';

const BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const MODEL = 'glm-5.3';
const RUNS_A = 5;
const RUNS_B = 3;
const PROMPT_A = '帮我把 Keynote 里这份演示文稿第 3 页的标题改成“2026 年度经营复盘”。';
const PROMPT_B = '给 zhang.wei@example.com 发一封邮件，说明天下午三点的评审会改到四点。';
const LADDER_LINE = /^- Capability ladder:.*\n?/mu;

type Arm = 'NEW' | 'OLD';
interface SchemaLike { name: string; description: string; inputSchema: unknown }

loadDotenv({ path: path.join(process.env.HOME ?? '', '.code-agent', '.env'), quiet: true });

function cuaDefinitions(): SchemaLike[] {
  delete process.env.CODE_AGENT_CUA_STATE_V2;
  const registry = new MCPToolRegistry();
  registry.tools = ['launch_app', 'get_window_state', 'click'].map((name) => ({
    serverName: 'cua-driver',
    name,
    description: `CUA tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
  }));
  return registry.getToolDefinitions() as unknown as SchemaLike[];
}

function toolsForArm(arm: Arm): unknown[] {
  const all = [
    bashSchema, readSchema, browserActionSchema, mailSchema, calendarSchema,
    ...cuaDefinitions(), cuaStatefulComputerUseSchema,
  ] as unknown as SchemaLike[];
  return all.map((tool) => {
    const description = arm === 'NEW'
      ? tool.description
      : tool.description.split(` ${CUA_SCREEN_LADDER_TOOL_SUFFIX}`).join('').split(CUA_SCREEN_LADDER_TOOL_SUFFIX).join('');
    return { type: 'function', function: { name: tool.name, description, parameters: tool.inputSchema } };
  });
}

function promptForArm(arm: Arm): string {
  const prompt = buildPrompt();
  if (arm === 'NEW') return prompt;
  if (!LADDER_LINE.test(prompt)) throw new Error('ladder line not found in prompt');
  return prompt.replace(LADDER_LINE, '');
}

async function call(messages: unknown[], tools: unknown[]): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ZHIPU_CODING_API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools, stream: false, max_tokens: 2048 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const json = await response.json() as { choices: Array<{ message: Record<string, unknown> }> };
  return json.choices[0].message;
}

function summarize(message: Record<string, unknown>): Record<string, unknown> {
  const calls = (message.tool_calls as Array<{ function: { name: string } }> | undefined) ?? [];
  return {
    content: (message.content as string | null) ?? '',
    reasoning_content: (message.reasoning_content as string | undefined) ?? '',
    firstTool: calls[0]?.function.name ?? '(none)',
  };
}

async function main(): Promise<void> {
  if (process.env.CUA_SCREEN_SENTENCE_REAL_EVAL !== '1') throw new Error('Set CUA_SCREEN_SENTENCE_REAL_EVAL=1');
  if (!process.env.ZHIPU_CODING_API_KEY) throw new Error('ZHIPU_CODING_API_KEY missing');
  const out: Record<string, unknown> = { model: MODEL, promptA: PROMPT_A, promptB: PROMPT_B, A: [], B: [] };

  for (let i = 0; i < RUNS_A; i += 1) {
    for (const arm of ['NEW', 'OLD'] as const) {
      const message = await call(
        [{ role: 'system', content: promptForArm(arm) }, { role: 'user', content: PROMPT_A }],
        toolsForArm(arm),
      );
      (out.A as unknown[]).push({ arm, run: i + 1, ...summarize(message) });
    }
  }
  const unavailable = 'Mail connector: unavailable\nMail connector is not configured in this runtime.\nCapabilities: none';
  for (let i = 0; i < RUNS_B; i += 1) {
    const message = await call([
      { role: 'system', content: promptForArm('NEW') },
      { role: 'user', content: PROMPT_B },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_mail_status', type: 'function', function: { name: 'mail', arguments: '{"action":"get_status"}' } }] },
      { role: 'tool', tool_call_id: 'call_mail_status', content: unavailable },
    ], toolsForArm('NEW'));
    (out.B as unknown[]).push({ arm: 'NEW', run: i + 1, ...summarize(message) });
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
