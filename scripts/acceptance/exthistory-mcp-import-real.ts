#!/usr/bin/env npx tsx
// Real GLM acceptance for N-EXTHISTORY-IMPORT-K1B-MCP acceptance ⑥.
// Run: env -u HTTPS_PROXY -u HTTP_PROXY npx tsx scripts/acceptance/exthistory-mcp-import-real.ts --keep

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as dotenv from 'dotenv';
import type { Message } from '../../src/shared/contract';

const PROVIDER = 'zhipu';
const MODEL = 'glm-5.3';
const CODING_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const SERVER_NAME = 'external-import-nonce';
const TOOL_NAME = 'mcp__external-import-nonce__get_random_nonce';
const SECRET = 'sk-FIXTURE-SECRET-123';

function loadEnvIntoProcess(realHome: string): void {
  try {
    const values = dotenv.parse(readFileSync(join(realHome, '.code-agent', '.env'), 'utf8'));
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
  } catch {
    // The required key is checked explicitly below.
  }
}

async function main(): Promise<void> {
  const realHome = process.env.HOME || homedir();
  loadEnvIntoProcess(realHome);
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.https_proxy;
  delete process.env.http_proxy;
  const apiKey = process.env.ZHIPU_CODING_API_KEY;
  if (!apiKey) throw new Error('ZHIPU_CODING_API_KEY is not configured (expected in ~/.code-agent/.env)');

  const keep = process.argv.includes('--keep') || Boolean(process.env.EXTERNAL_MCP_REAL_ROOT);
  const root = process.env.EXTERNAL_MCP_REAL_ROOT || mkdtempSync(join(tmpdir(), 'exthistory-mcp-real-'));
  const dataDir = join(root, 'data');
  const workspace = join(root, 'workspace');
  mkdirSync(join(root, '.cursor'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  process.env.HOME = root;
  process.env.CODE_AGENT_HOME = root;
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_E2E = '1';
  process.env.CODE_AGENT_WEB_MODE = 'true';
  process.env.CODE_AGENT_CUA_DRIVER_PATH ||= 'cua-driver';

  const nonceServerPath = resolve('tests/fixtures/mcp/external-import-nonce-server.mjs');
  writeFileSync(join(root, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: { command: process.execPath, args: [nonceServerPath] },
      'secret-fixture': {
        command: 'npx',
        args: ['-y', 'secret-mcp'],
        env: { GITHUB_TOKEN: SECRET },
      },
    },
  }, null, 2));

  const axios = (await import('axios')).default;
  const modelRequests: Array<{ url: unknown; model: unknown }> = [];
  const requestInterceptor = axios.interceptors.request.use((config) => {
    if (typeof config.data === 'string') {
      try {
        const parsed = JSON.parse(config.data) as { model?: unknown };
        modelRequests.push({ url: config.url, model: parsed.model });
      } catch {
        // Ignore non-JSON requests.
      }
    }
    return config;
  });

  try {
    const { StandaloneAgentAdapter } = await import('../../src/host/testing/agentAdapter');
    await StandaloneAgentAdapter._ensureElectronMock();
    const { initializeCLIServices } = await import('../../src/cli/bootstrap');
    await initializeCLIServices({ dangerouslySkipPermissions: true });
    const { initMCPClient, getMCPClient } = await import('../../src/host/mcp/mcpClient');
    await initMCPClient(undefined, workspace);
    const { applyExternalMcpImport } = await import('../../src/host/externalImport/mcpServersImport');
    const { updateMcpServerEnabledInConfigFiles } = await import('../../src/host/ipc/mcp.ipc');
    const { getDatabase } = await import('../../src/host/services/core/databaseService');
    const { resolveSessionDefaultModelConfig } = await import('../../src/host/services/core/sessionDefaults');
    const { AgentLoop } = await import('../../src/host/agent/agentLoop');
    const { ToolExecutor } = await import('../../src/host/tools/toolExecutor');
    const { SYSTEM_PROMPT } = await import('../../src/host/prompts/builder');

    const imported = await applyExternalMcpImport({ sourceIds: ['cursor'] });
    if (imported.imported !== 2) throw new Error(`expected two disabled imports: ${JSON.stringify(imported)}`);
    const importedConfig = JSON.parse(readFileSync(join(dataDir, 'mcp.json'), 'utf8')) as {
      servers: Array<{ name: string; enabled: boolean }>;
    };
    if (importedConfig.servers.some((server) => server.enabled)) {
      throw new Error('an imported server was enabled before explicit confirmation');
    }

    await getMCPClient().setServerEnabled(SERVER_NAME, true);
    await updateMcpServerEnabledInConfigFiles(SERVER_NAME, true, workspace);
    const enabledConfig = JSON.parse(readFileSync(join(dataDir, 'mcp.json'), 'utf8')) as {
      servers: Array<{ name: string; enabled: boolean }>;
    };
    if (enabledConfig.servers.find((server) => server.name === SERVER_NAME)?.enabled !== true
      || enabledConfig.servers.find((server) => server.name === 'secret-fixture')?.enabled !== false) {
      throw new Error('per-server enable did not persist exactly one server');
    }

    const database = getDatabase();
    await database.initialize();
    const sessionId = `external-mcp-real-${Date.now()}`;
    database.createSessionWithId(sessionId, {
      title: 'External MCP real GLM acceptance',
      modelConfig: { provider: PROVIDER, model: MODEL },
      workingDirectory: workspace,
      type: 'chat',
    });

    const prompt = [
      `必须实际调用工具 ${TOOL_NAME}，不要调用其他工具。`,
      '然后把工具输出中的 EXTERNAL_MCP_NONCE=<uuid> 原样作为唯一一行回复。',
    ].join('\n');
    const messages: Message[] = [{ id: `user-${Date.now()}`, role: 'user', content: prompt, timestamp: Date.now() }];
    const toolCalls: string[] = [];
    const toolOutputs: string[] = [];
    const errors: string[] = [];
    const modelConfig = resolveSessionDefaultModelConfig({ provider: PROVIDER, model: MODEL });
    const loop = new AgentLoop({
      sessionId,
      workingDirectory: workspace,
      projectConfigDirectory: workspace,
      systemPrompt: SYSTEM_PROMPT,
      modelConfig: {
        ...modelConfig,
        provider: PROVIDER,
        model: MODEL,
        apiKey,
        baseUrl: CODING_BASE_URL,
        temperature: 0,
        reasoningEffort: 'low',
        maxTokens: 2048,
      },
      maxIterations: 4,
      enableToolDeferredLoading: false,
      allowedToolNames: [TOOL_NAME],
      autoApprovePlan: true,
      persistLongTermMemory: false,
      includeRecentConversations: false,
      toolExecutor: new ToolExecutor({ requestPermission: async () => true, workingDirectory: workspace }),
      messages,
      onEvent: (event) => {
        if (event.type === 'tool_call_start') {
          toolCalls.push(event.data.name);
          console.log(`RAW tool_call_start: ${JSON.stringify(event.data)}`);
        } else if (event.type === 'tool_call_end') {
          const data = event.data as { success?: boolean; output?: unknown; error?: unknown };
          toolOutputs.push(String(data.output ?? data.error ?? ''));
          console.log(`RAW tool_call_end: ${JSON.stringify(event.data)}`);
        } else if (event.type === 'error') {
          errors.push(String((event.data as { message?: unknown } | undefined)?.message ?? 'unknown runtime error'));
        }
      },
    });

    await loop.run(prompt);
    if (errors.length > 0) throw new Error(`agent loop errors: ${errors.join(' | ')}`);
    const toolOutput = toolOutputs.join('\n');
    const nonce = /EXTERNAL_MCP_NONCE=([0-9a-f-]{36})/.exec(toolOutput)?.[1];
    if (!nonce) throw new Error(`MCP tool output has no nonce: ${toolOutput.slice(0, 500)}`);
    if (!toolCalls.includes(TOOL_NAME)) throw new Error(`expected tool was not called: ${toolCalls.join(', ')}`);
    const replyMessage = [...messages].reverse().find((message) => message.role === 'assistant');
    const reply = typeof replyMessage?.content === 'string' ? replyMessage.content : '';
    if (!reply.includes(nonce)) throw new Error(`model reply did not return tool nonce ${nonce}: ${reply.slice(0, 500)}`);
    if (modelRequests.length === 0 || modelRequests.some((request) => request.model !== MODEL)) {
      throw new Error(`real GLM request was not observed: ${JSON.stringify(modelRequests)}`);
    }

    console.log('=== EXTHISTORY-MCP REAL GLM RUN PASS ===');
    console.log(`new session: ${sessionId}`);
    console.log(`provider requests: ${JSON.stringify(modelRequests)}`);
    console.log(`tool calls: ${JSON.stringify(toolCalls)}`);
    console.log(`RAW tool nonce output: EXTERNAL_MCP_NONCE=${nonce}`);
    console.log('--- raw model reply ---');
    console.log(reply);
    console.log(`fixture root: ${root}`);

    await getMCPClient().disconnectAll();
    database.close();
  } finally {
    axios.interceptors.request.eject(requestInterceptor);
    try {
      const { getMCPClient } = await import('../../src/host/mcp/mcpClient');
      await getMCPClient().disconnectAll();
    } catch {
      // The client may not have initialized on an early failure.
    }
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('=== EXTHISTORY-MCP REAL GLM RUN FAIL ===');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
