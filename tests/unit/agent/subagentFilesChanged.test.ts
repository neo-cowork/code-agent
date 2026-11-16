// ============================================================================
// SubagentResult.filesChanged：非 worktree 成员真实写过的文件进完成账本
// ============================================================================
// 真 SubagentExecutor.execute + 本地假模型 HTTP 服务 + 真 Write / Read 工具。
// 模型分两轮写文件（跨 turn 累计、重复写同一文件去重），只读成员不产生 filesChanged。
// ============================================================================
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type ToolStep = Array<{ name: string; args: Record<string, unknown> }>;

let root: string;
let cwd: string;
let registry: ReturnType<typeof import('../../../src/host/tools/protocolRegistry').getProtocolRegistry>;
let SubagentExecutor: typeof import('../../../src/host/agent/subagentExecutor').SubagentExecutor;

function startScriptedModel(steps: ToolStep[]): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        const toolRounds = (body.match(/"role":"tool"/g) ?? []).length;
        const step = steps[Math.min(toolRounds, steps.length)];
        const message = step && toolRounds < steps.length
          ? {
              role: 'assistant',
              content: null,
              tool_calls: step.map((call, i) => ({
                id: `call_${toolRounds}_${i}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            }
          : { role: 'assistant', content: 'done' };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'scripted', object: 'chat.completion', created: 1, model: 'glm-5.3',
          choices: [{ index: 0, message, finish_reason: message.content === null ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      resolve({
        url: `http://127.0.0.1:${address.port}/v4`,
        close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }),
      });
    });
  });
}

async function runMember(agentId: string, tools: string[], steps: ToolStep[]) {
  const fake = await startScriptedModel(steps);
  try {
    return await new SubagentExecutor().execute({
      prompt: 'Do the scripted work, then finish.',
      config: {
        name: `fc-${agentId}`,
        systemPrompt: 'You are a terse worker.',
        availableTools: tools,
        maxIterations: 8,
        maxExecutionTimeMs: 30_000,
        permissionPreset: 'development',
      },
      context: {
        sessionId: `session-${agentId}`,
        executionAgentId: agentId,
        cwd,
        workspace: cwd,
        modelConfig: { provider: 'zhipu', model: 'glm-5.3', apiKey: 'scripted-test-key', baseUrl: fake.url, temperature: 0 },
        resolver: {
          getDefinition: (name) => {
            const schema = registry.getSchemas().find((candidate) => candidate.name === name);
            return schema ? {
              name: schema.name,
              description: schema.description,
              inputSchema: schema.inputSchema,
              outputSchema: schema.outputSchema,
              requiresPermission: schema.requiresPermission ?? false,
              permissionLevel: schema.permissionLevel === 'dangerous' ? 'execute' : schema.permissionLevel,
              readOnly: schema.readOnly,
              touchesWorkDirectory: schema.touchesWorkDirectory,
            } : undefined;
          },
        },
        permission: { request: async () => true },
        events: { emit: () => {} },
        abortSignal: new AbortController().signal,
      },
    });
  } finally {
    await fake.close();
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'subagent-files-changed-'));
  cwd = path.join(root, 'work');
  await mkdir(path.join(root, 'data'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  vi.stubEnv('CODE_AGENT_HOME', root);
  vi.stubEnv('CODE_AGENT_DATA_DIR', path.join(root, 'data'));
  vi.stubEnv('CODE_AGENT_LOG_DIR', path.join(root, 'logs'));
  registry = (await import('../../../src/host/tools/protocolRegistry')).getProtocolRegistry();
  ({ SubagentExecutor } = await import('../../../src/host/agent/subagentExecutor'));
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe.sequential('SubagentExecutor.execute filesChanged', () => {
  it('records real written paths across turns, each path once (a repeated or rejected write adds nothing)', async () => {
    const a = path.join(cwd, 'kickoff.md');
    const b = path.join(cwd, 'risks.md');
    const result = await runMember('writer', ['Write'], [
      [{ name: 'Write', args: { file_path: a, content: '# kickoff\n' } }],
      [{ name: 'Write', args: { file_path: b, content: '# risks\n' } }, { name: 'Write', args: { file_path: a, content: '# kickoff v2\n' } }],
    ]);
    expect(result.success).toBe(true);
    expect(await readFile(a, 'utf8')).toContain('# kickoff');
    expect([...(result.filesChanged ?? [])].sort()).toEqual([a, b].sort());
  });

  it('a read-only member leaves filesChanged empty', async () => {
    const note = path.join(cwd, 'notes.txt');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(note, 'hello\n');
    const result = await runMember('reader', ['Read'], [
      [{ name: 'Read', args: { file_path: note } }],
    ]);
    expect(result.success).toBe(true);
    expect(result.filesChanged ?? []).toEqual([]);
  });
});
