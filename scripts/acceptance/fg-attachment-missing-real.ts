#!/usr/bin/env npx tsx
// N-FIX-ATTACHMENT-NOT-IN-WORKDIR-FU1：真实模型回放「口头提到附件但未上传」的前台表现。
// 用法：set -a; source ~/.code-agent/.env; set +a
//       npx tsx scripts/acceptance/fg-attachment-missing-real.ts
//       npx tsx scripts/acceptance/fg-attachment-missing-real.ts --provider xiaomi
//       npx tsx scripts/acceptance/fg-attachment-missing-real.ts --expect-after
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { AppServiceRunOptions } from '../../src/shared/contract/appService';
import type { ToolSchema } from '../../src/host/protocol/tools';
import { STEPFUN_TIER, ZHIPU_CODING_TIER } from './_jev-real-sites-lib';

const ROUNDS = 3;
const TEMPERATURE = 0;
const MAX_OUTPUT_TOKENS = 8192;
const CALL_TIMEOUT_MS = 180_000;
const MAX_MODEL_STEPS = 8;

const PROMPTS = [
  {
    id: 'P1',
    text: '分析这张销售表',
    expectMissingAttachment: true,
  },
  {
    id: 'P2',
    text: '看看我上传的附件',
    expectMissingAttachment: true,
  },
  {
    id: 'P3',
    text: '写一首关于春天的短诗',
    expectMissingAttachment: false,
  },
  {
    id: 'P4',
    text: '帮我设计这个项目的需求文档',
    expectMissingAttachment: false,
  },
] as const;

type PromptId = typeof PROMPTS[number]['id'];
type Provider = 'xiaomi' | 'zhipu' | 'stepfun';

interface ReplayTier {
  model: string;
  baseUrl: string;
}

interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface AssistantMessage {
  content?: unknown;
  tool_calls?: ToolCall[];
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface RoundResult {
  totalToolCalls: number;
  workspaceCheckCalls: number;
  externalScanCalls: number;
  touchedPaths: string[];
  externalPaths: string[];
  asksReuploadOrPath: boolean;
  cancelledOrEmptyTurn: boolean;
  finalReply: string;
}

interface PromptTotals {
  totalToolCalls: number;
  maxToolCallsInRound: number;
  maxWorkspaceChecksInRound: number;
  externalScanCalls: number;
  asksReuploadOrPathRounds: number;
  cancelledOrEmptyRounds: number;
}

const FAKE_TOOL_NAMES = ['ListDirectory', 'Glob', 'Read', 'Bash'] as const;

let buildPromptFn: typeof import('../../src/host/prompts/builder').buildPrompt;
let injectWorkingDirectoryContextFn: typeof import('../../src/host/agent/messageHandling/contextBuilder').injectWorkingDirectoryContext;
let wrapWithTurnSystemContextFn: typeof import('../../src/host/agent/turnScaffold').wrapWithTurnSystemContext;
let getProtocolRegistryFn: typeof import('../../src/host/tools/protocolRegistry').getProtocolRegistry;
let withMissingAttachmentTurnSystemContextFn: ((
  options: AppServiceRunOptions | undefined,
  input: {
    sessionId: string;
    userText: string;
    attachments?: readonly [];
    session?: null;
    workingDirectory?: string;
  },
) => AppServiceRunOptions | undefined) | undefined;

async function loadProductModules(): Promise<void> {
  const [builder, contextBuilder, turnScaffold, registry] = await Promise.all([
    import('../../src/host/prompts/builder'),
    import('../../src/host/agent/messageHandling/contextBuilder'),
    import('../../src/host/agent/turnScaffold'),
    import('../../src/host/tools/protocolRegistry'),
  ]);
  buildPromptFn = builder.buildPrompt;
  injectWorkingDirectoryContextFn = contextBuilder.injectWorkingDirectoryContext;
  wrapWithTurnSystemContextFn = turnScaffold.wrapWithTurnSystemContext;
  getProtocolRegistryFn = registry.getProtocolRegistry;

  const missingAttachmentModulePath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../src/host/app/missingAttachmentTurnContext.ts',
  );
  if (fs.existsSync(missingAttachmentModulePath)) {
    const mod = await import('../../src/host/app/missingAttachmentTurnContext');
    withMissingAttachmentTurnSystemContextFn = mod.withMissingAttachmentTurnSystemContext;
  }
}

function wireTools(): Array<Record<string, unknown>> {
  const allowed = new Set<string>(FAKE_TOOL_NAMES);
  const schemas = getProtocolRegistryFn().getSchemas()
    .filter((schema) => allowed.has(schema.name));
  for (const required of FAKE_TOOL_NAMES) {
    if (!schemas.some((schema) => schema.name === required)) {
      throw new Error(`required replay tool is missing: ${required}`);
    }
  }
  return schemas.map(toWireTool);
}

function toWireTool(schema: ToolSchema): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.inputSchema,
    },
  };
}

function extractCallTarget(call: ToolCall): string {
  const rawArgs = call.function?.arguments ?? '{}';
  try {
    const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    for (const key of ['path', 'file_path', 'command', 'working_directory', 'pattern']) {
      if (typeof parsed[key] === 'string' && parsed[key].trim()) {
        return parsed[key].trim();
      }
    }
  } catch {
    return rawArgs;
  }
  return '.';
}

function isExternalScanTarget(target: string, workdir: string): boolean {
  const normalized = target.replace(/\\/g, '/');
  if (/(?:^|\/|~\/)(?:Downloads|Desktop|Documents)(?:\/|$|\b)/i.test(normalized)) {
    return true;
  }
  if (/任务_\d{4}_|Task_\d{4}_/.test(normalized) && !normalized.includes(path.basename(workdir))) {
    return true;
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/..')) {
    return true;
  }
  const home = os.homedir().replace(/\\/g, '/');
  if (/\bfind\s+(?:~|\/Users\/)/i.test(normalized)) {
    return true;
  }
  if ((normalized === '~' || normalized === home || normalized.startsWith('~/Neo') || normalized.startsWith(`${home}/Neo`))
    && !normalized.startsWith(workdir.replace(/\\/g, '/'))) {
    return true;
  }
  return false;
}

function replayToolOutput(call: ToolCall): string {
  const name = call.function?.name;
  const target = extractCallTarget(call);
  if (name === 'ListDirectory') {
    return '(empty — this task folder has no files yet)';
  }
  if (name === 'Glob') {
    return 'No files matched the pattern';
  }
  if (name === 'Read') {
    return `Error: File not found: ${target}`;
  }
  if (name === 'Bash') {
    return '(empty — command returned no matching files)';
  }
  return JSON.stringify({ ok: false, error: `unsupported tool ${name ?? 'unknown'}` });
}

function score(messages: AssistantMessage[], workdir: string): RoundResult {
  const toolCalls = messages.flatMap((message) => (
    Array.isArray(message.tool_calls) ? message.tool_calls : []
  ));
  const touchedPaths = toolCalls.map((call) => `${call.function?.name ?? '?'}:${extractCallTarget(call)}`);
  const externalPaths = toolCalls
    .map((call) => `${call.function?.name ?? '?'}:${extractCallTarget(call)}`)
    .filter((entry) => {
      const idx = entry.indexOf(':');
      const target = idx === -1 ? entry : entry.slice(idx + 1);
      return isExternalScanTarget(target, workdir);
    });
  const externalScanCalls = externalPaths.length;
  const workspaceCheckCalls = toolCalls.length - externalScanCalls;

  const lastMessage = messages[messages.length - 1];
  const lastToolCalls = Array.isArray(lastMessage?.tool_calls) ? lastMessage.tool_calls : [];
  const finalReply = typeof lastMessage?.content === 'string' ? lastMessage.content.trim() : '';
  const cancelledOrEmptyTurn = lastToolCalls.length > 0 || finalReply.length === 0;

  const mentionsMissing = /未收到|没收到|没有收到|未找到|没找到|没有找到|未发现|没看到|没有看到|未上传|没上传|没有上传|未附带|没有附带|空|不存在|missing|not\s+found|no\s+attachment|not\s+attached/i.test(finalReply);
  const asksAction = /重新上传|再上传|上传一下|发一下|提供.{0,12}(?:路径|文件|附件)|附上|拖(?:入|拽)|发送.{0,8}(?:文件|附件|表格)|告诉我.{0,12}(?:路径|位置)|给.{0,8}(?:路径|文件)|(?:文件|附件)的?(?:文件名或)?路径|re-?upload|provide.{0,16}path/i.test(finalReply);

  return {
    totalToolCalls: toolCalls.length,
    workspaceCheckCalls,
    externalScanCalls,
    touchedPaths,
    externalPaths,
    asksReuploadOrPath: mentionsMissing && asksAction,
    cancelledOrEmptyTurn,
    finalReply,
  };
}

async function chatCall(
  apiKey: string,
  provider: Provider,
  tier: ReplayTier,
  messages: ChatMessage[],
  tools: Array<Record<string, unknown>>,
): Promise<AssistantMessage> {
  const response = await fetch(`${tier.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: tier.model,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: TEMPERATURE,
      max_tokens: MAX_OUTPUT_TOKENS,
      ...(provider === 'xiaomi' ? { thinking: { type: 'disabled' } } : {}),
    }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ''}`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: AssistantMessage }> };
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error(`response has no assistant message: ${JSON.stringify(payload)}`);
  return message;
}

async function runRound(
  apiKey: string,
  provider: Provider,
  tier: ReplayTier,
  prompt: typeof PROMPTS[number],
  round: number,
  tools: Array<Record<string, unknown>>,
  workdir: string,
): Promise<AssistantMessage[]> {
  const systemPrompt = injectWorkingDirectoryContextFn(buildPromptFn(), workdir, true);
  const options = withMissingAttachmentTurnSystemContextFn
    ? withMissingAttachmentTurnSystemContextFn(undefined, {
        sessionId: `replay-${prompt.id}-r${round}`,
        userText: prompt.text,
        attachments: [],
        session: null,
        workingDirectory: workdir,
      })
    : undefined;
  const turnSystemContext = options?.turnSystemContext ?? [];
  const userContent = wrapWithTurnSystemContextFn(turnSystemContext, prompt.text);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  const assistantMessages: AssistantMessage[] = [];
  for (let step = 0; step < MAX_MODEL_STEPS; step += 1) {
    const message = await chatCall(apiKey, provider, tier, messages, tools);
    assistantMessages.push(message);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) break;
    messages.push({
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : null,
      tool_calls: toolCalls,
    });
    for (const [index, call] of toolCalls.entries()) {
      messages.push({
        role: 'tool',
        content: replayToolOutput(call),
        tool_call_id: call.id ?? `replay-${step}-${index}`,
      });
    }
  }
  return assistantMessages;
}

async function runPrompt(
  apiKey: string,
  provider: Provider,
  tier: ReplayTier,
  prompt: typeof PROMPTS[number],
  tools: Array<Record<string, unknown>>,
): Promise<PromptTotals> {
  const totals: PromptTotals = {
    totalToolCalls: 0,
    maxToolCallsInRound: 0,
    maxWorkspaceChecksInRound: 0,
    externalScanCalls: 0,
    asksReuploadOrPathRounds: 0,
    cancelledOrEmptyRounds: 0,
  };
  const workdir = path.join(os.homedir(), 'Neo', `任务_1107_${prompt.id}`);
  for (let round = 1; round <= ROUNDS; round += 1) {
    const messages = await runRound(apiKey, provider, tier, prompt, round, tools, workdir);
    const result = score(messages, workdir);
    totals.totalToolCalls += result.totalToolCalls;
    totals.maxToolCallsInRound = Math.max(totals.maxToolCallsInRound, result.totalToolCalls);
    totals.maxWorkspaceChecksInRound = Math.max(totals.maxWorkspaceChecksInRound, result.workspaceCheckCalls);
    totals.externalScanCalls += result.externalScanCalls;
    totals.asksReuploadOrPathRounds += Number(result.asksReuploadOrPath);
    totals.cancelledOrEmptyRounds += Number(result.cancelledOrEmptyTurn);
    console.log([
      'RAW',
      `provider=${provider}`,
      `prompt=${prompt.id}`,
      `round=${round}`,
      `tool_calls=${result.totalToolCalls}`,
      `workspace_checks=${result.workspaceCheckCalls}`,
      `external_scans=${result.externalScanCalls}`,
      `asks_reupload=${Number(result.asksReuploadOrPath)}`,
      `cancelled_or_empty=${Number(result.cancelledOrEmptyTurn)}`,
      `touched_paths=${JSON.stringify(result.touchedPaths)}`,
      `external_paths=${JSON.stringify(result.externalPaths)}`,
      `final_reply=${JSON.stringify(result.finalReply)}`,
    ].join(' '));
  }
  console.log(`SUMMARY provider=${provider} prompt=${prompt.id} rounds=${ROUNDS} total_tool_calls=${totals.totalToolCalls} max_tool_calls=${totals.maxToolCallsInRound} max_workspace_checks=${totals.maxWorkspaceChecksInRound} external_scans=${totals.externalScanCalls} asks_reupload=${totals.asksReuploadOrPathRounds}/${ROUNDS} cancelled_or_empty=${totals.cancelledOrEmptyRounds}/${ROUNDS}`);
  return totals;
}

function parseArgs(argv: string[]): { provider: Provider; expectAfter: boolean } {
  const providerIndex = argv.indexOf('--provider');
  const provider = providerIndex === -1 ? 'xiaomi' : argv[providerIndex + 1];
  if (provider !== 'xiaomi' && provider !== 'zhipu' && provider !== 'stepfun') {
    throw new Error('--provider must be xiaomi, zhipu, or stepfun');
  }
  const known = new Set(['--provider', 'xiaomi', 'zhipu', 'stepfun', '--expect-after']);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`unknown arguments: ${unknown.join(', ')}`);
  return { provider, expectAfter: argv.includes('--expect-after') };
}

function afterFailures(results: Record<PromptId, PromptTotals>): string[] {
  const failures: string[] = [];
  for (const id of ['P1', 'P2'] as const) {
    if (results[id].maxWorkspaceChecksInRound > 1) {
      failures.push(`${id}: max_workspace_checks=${results[id].maxWorkspaceChecksInRound} (>1)`);
    }
    if (results[id].externalScanCalls !== 0) {
      failures.push(`${id}: external_scans=${results[id].externalScanCalls}`);
    }
    if (results[id].asksReuploadOrPathRounds !== ROUNDS) {
      failures.push(`${id}: asks_reupload=${results[id].asksReuploadOrPathRounds}/${ROUNDS}`);
    }
    if (results[id].cancelledOrEmptyRounds !== 0) {
      failures.push(`${id}: cancelled_or_empty=${results[id].cancelledOrEmptyRounds}/${ROUNDS}`);
    }
  }
  if (results.P3.totalToolCalls !== 0) {
    failures.push(`P3: total_tool_calls=${results.P3.totalToolCalls}`);
  }
  if (results.P3.cancelledOrEmptyRounds !== 0) {
    failures.push(`P3: cancelled_or_empty=${results.P3.cancelledOrEmptyRounds}/${ROUNDS}`);
  }
  if (results.P4.asksReuploadOrPathRounds !== 0) {
    failures.push(`P4: asks_reupload=${results.P4.asksReuploadOrPathRounds}/${ROUNDS} (creation request must not ask for a re-upload)`);
  }
  // P4 only asserts "no re-upload ask". With fake empty tools the model keeps exploring for "这个项目"
  // (identical with/without the fix and rule A: workspace/external scans, step-cap exhausted) — not gated here.
  return failures;
}

async function main(): Promise<void> {
  const { provider, expectAfter } = parseArgs(process.argv.slice(2));
  const xiaomiBaseUrl = (process.env.XIAOMI_API_URL ?? '').trim().replace(/\/+$/, '');
  const tier: ReplayTier = provider === 'xiaomi'
    ? { model: 'mimo-v2.6-flash', baseUrl: xiaomiBaseUrl }
    : provider === 'zhipu' ? ZHIPU_CODING_TIER : STEPFUN_TIER;
  const keyEnv = provider === 'xiaomi'
    ? 'XIAOMI_API_KEY'
    : provider === 'zhipu' ? 'ZHIPU_CODING_API_KEY' : 'STEPFUN_API_KEY';
  if (!tier.baseUrl) throw new Error('XIAOMI_API_URL is required for the xiaomi replay');
  const apiKey = (process.env[keyEnv] ?? '').trim();
  if (!apiKey) throw new Error(`${keyEnv} is required; refusing to skip the real-model replay`);
  await loadProductModules();
  const tools = wireTools();
  console.log(`REPLAY provider=${provider} model=${tier.model} endpoint=${tier.baseUrl} temperature=${TEMPERATURE} rounds=${ROUNDS} helper_loaded=${Boolean(withMissingAttachmentTurnSystemContextFn)} tools=${JSON.stringify(FAKE_TOOL_NAMES)}`);
  const results = {} as Record<PromptId, PromptTotals>;
  for (const prompt of PROMPTS) {
    results[prompt.id] = await runPrompt(apiKey, provider, tier, prompt, tools);
  }
  if (expectAfter) {
    const failures = afterFailures(results);
    if (failures.length > 0) throw new Error(`after expectations failed: ${failures.join('; ')}`);
    console.log('AFTER_EXPECTATIONS PASS');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
