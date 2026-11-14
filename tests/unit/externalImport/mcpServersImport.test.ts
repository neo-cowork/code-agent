// ============================================================================
// mcpServersImport + detectSources + mcp.ipc 路由联合单测
// （N-EXTHISTORY-IMPORT-K1B-MCP-REDESIGN）
// ============================================================================

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';
import type {
  ExternalMcpApplyResult,
  ExternalMcpPreviewResult,
} from '../../../src/shared/contract/externalImport';

const SECRET_LITERAL = 'sk-FIXTURE-SECRET-123';

const logSink = vi.hoisted(() => [] as string[]);
const capturedLogs = () => logSink.join('\n');

const dryRunMock = vi.hoisted(() => vi.fn());
const runtimeAddServer = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/memory/importers', () => ({
  dryRunMemoryHarnessImport: dryRunMock,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => {
      logSink.push(JSON.stringify(args));
    },
    warn: (...args: unknown[]) => {
      logSink.push(JSON.stringify(args));
    },
    error: (...args: unknown[]) => {
      logSink.push(JSON.stringify(args));
    },
    debug: (...args: unknown[]) => {
      logSink.push(JSON.stringify(args));
    },
  }),
}));

vi.mock('../../../src/host/mcp/mcpClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/mcp/mcpClient')>()),
  getMCPClient: () => ({
    getServerStates: () => [],
    addServer: runtimeAddServer,
  }),
}));

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getMcpCatalog: () => [] }),
}));

import {
  applyExternalMcpImport,
  countExternalMcpImportCandidates,
  planExternalMcpImport,
} from '../../../src/host/externalImport/mcpServersImport';
import { detectExternalImportSources } from '../../../src/host/externalImport/detectSources';
import { registerMcpHandlers } from '../../../src/host/ipc/mcp.ipc';
import { loadMcpConfigFiles } from '../../../src/host/mcp/mcpConfigFile';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

let tmpRoot: string;
let homeDir: string;
let dataDir: string;
let invokeMcpIpc: (action: string, payload?: unknown) => Promise<IPCResponse>;

beforeEach(async () => {
  logSink.length = 0;
  runtimeAddServer.mockReset();
  dryRunMock.mockReset();
  dryRunMock.mockResolvedValue({
    instructions: [],
    summary: { discoveredMemory: 0, readyToImport: 0, duplicates: 0, instructionOnly: 0, archived: 0 },
  });
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'external-mcp-import-'));
  homeDir = path.join(tmpRoot, 'home');
  dataDir = path.join(tmpRoot, 'data');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  vi.stubEnv('CODE_AGENT_HOME', homeDir);
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);

  const handlers = new Map<string, HandlerFn>();
  registerMcpHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never, {
    getWorkingDirectory: () => tmpRoot,
  });
  const handler = handlers.get(IPC_DOMAINS.MCP)!;
  invokeMcpIpc = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeFullFixtureHome(): Promise<void> {
  await fs.mkdir(path.join(homeDir, '.claude'), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, '.claude.json'),
    JSON.stringify(
      {
        numStartups: 42,
        mcpServers: {
          github: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_TOKEN: SECRET_LITERAL },
          },
          'context7-disabled': {
            command: 'npx',
            args: ['-y', '@upstash/context7-mcp'],
            disabled: true,
          },
          sentry: {
            type: 'http',
            url: 'https://mcp.sentry.dev/sse',
            headers: { Authorization: `Bearer ${SECRET_LITERAL}` },
          },
        },
        projects: {
          '/tmp/some-project': {
            mcpServers: {
              'project-only': { command: 'echo', args: ['project'] },
            },
          },
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  const desktopDir = path.join(homeDir, 'Library', 'Application Support', 'Claude');
  await fs.mkdir(desktopDir, { recursive: true });
  await fs.writeFile(
    path.join(desktopDir, 'claude_desktop_config.json'),
    JSON.stringify(
      {
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            env: { FS_ROOT: '/tmp' },
          },
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  await fs.mkdir(path.join(homeDir, '.cursor'), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, '.cursor', 'mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
          },
          notion: {
            command: 'npx',
            args: ['-y', '@notionhq/notion-mcp-server'],
            env: {
              OPENAPI_MCP_HEADERS: `{"Notion-Version":"2022-06-01","Authorization":"Bearer ${SECRET_LITERAL}"}`,
            },
          },
          'db-placeholder': {
            command: 'npx',
            args: ['-y', 'db-mcp', '${DB_URL}'],
          },
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, '.codex', 'config.toml'),
    [
      'model = "gpt-5"',
      '',
      '[mcp_servers.websearch]',
      'command = "uvx"',
      'args = ["mcp-server-fetch"]',
      `env = { "FETCH_TIMEOUT" = "5000", "API_SECRET_TOKEN" = "${SECRET_LITERAL}" }`,
      'env_vars = ["OPENAI_API_KEY"]',
      'enabled = true',
      '',
      '[mcp_servers.sentinel-remote]',
      'url = "https://mcp.example.com/stream"',
      'bearer_token_env_var = "SENTINEL_TOKEN"',
      'env_http_headers = { "X-Api-Version" = "SENTINEL_API_VERSION" }',
      'http_headers = { "X-Client" = "neo-import-test" }',
      '',
      '[mcp_servers.observability]',
      'command = "npx"',
      'args = ["-y", "observability-mcp"]',
      'enabled = false',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function itemByName<T extends { name: string; sourceId?: string }>(items: T[], name: string, sourceId?: string): T {
  const found = sourceId
    ? items.filter((item) => item.name === name && item.sourceId === sourceId)
    : items.filter((item) => item.name === name);
  expect(found.length, `expected exactly one item named ${name}${sourceId ? ` (${sourceId})` : ''}`).toBe(1);
  return found[0];
}

describe('planExternalMcpImport & mcp.ipc preview：四来源读取与坏文件原因（验收①③⑤）', () => {
  it('四来源真实夹具经 mcp.ipc externalImportMcpPreview 全部读出并按安全规则映射；per-project 条目不读', async () => {
    await writeFullFixtureHome();
    const res = await invokeMcpIpc('externalImportMcpPreview', {});
    expect(res.success).toBe(true);
    const result = res.data as ExternalMcpPreviewResult;

    expect(result.files.map((file) => [file.sourceId, file.status])).toEqual([
      ['claude-code', 'ok'],
      ['claude-desktop', 'ok'],
      ['cursor', 'ok'],
      ['codex', 'ok'],
    ]);

    const github = itemByName(result.items, 'github', 'claude-code');
    expect(github.disposition).toBe('import');
    expect(github.kind).toBe('stdio');
    expect(github.commandSummary).toBe('npx -y @modelcontextprotocol/server-github');
    expect(github.neededEnvKeys).toEqual(['GITHUB_TOKEN']);

    const dup = itemByName(result.items, 'github', 'cursor');
    expect(dup.disposition).toBe('skip');
    expect(dup.reason).toBe('duplicate-across-sources');

    const notion = itemByName(result.items, 'notion');
    expect(notion.disposition).toBe('import');
    expect(notion.neededEnvKeys).toEqual(['OPENAPI_MCP_HEADERS']);

    expect(itemByName(result.items, 'db-placeholder').reason).toBe('placeholder-in-command');
    expect(itemByName(result.items, 'context7-disabled').reason).toBe('source-disabled');
    expect(itemByName(result.items, 'observability').reason).toBe('source-disabled');

    const sentry = itemByName(result.items, 'sentry');
    expect(sentry.disposition).toBe('import');
    expect(sentry.kind).toBe('remote');
    expect(sentry.commandSummary).toBe('https://mcp.sentry.dev/sse');
    expect(sentry.neededEnvKeys).toEqual(['Authorization']);

    const filesystem = itemByName(result.items, 'filesystem');
    expect(filesystem.disposition).toBe('import');
    expect(filesystem.neededEnvKeys).toEqual([]);

    const websearch = itemByName(result.items, 'websearch');
    expect(websearch.disposition).toBe('import');
    expect(websearch.commandSummary).toBe('uvx mcp-server-fetch');
    expect(websearch.neededEnvKeys).toEqual(['API_SECRET_TOKEN', 'OPENAI_API_KEY']);

    const sentinel = itemByName(result.items, 'sentinel-remote');
    expect(sentinel.disposition).toBe('import');
    expect(sentinel.kind).toBe('remote');
    expect(sentinel.neededEnvKeys).toEqual(['SENTINEL_API_VERSION', 'SENTINEL_TOKEN']);

    expect(result.items.some((item) => item.name === 'project-only')).toBe(false);
    expect(result.summary).toEqual({ import: 6, skip: 4 });
  });

  it('坏文件给文件级原因，绝不静默空列表；解析错误也不回显 secret（验收①③）', async () => {
    await fs.mkdir(path.join(homeDir, '.cursor'), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, '.cursor', 'mcp.json'),
      `{"mcpServers":{"broken":{"env":{"API_KEY":"${SECRET_LITERAL}"}},}}`,
      'utf-8',
    );
    await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, '.codex', 'config.toml'),
      `[mcp_servers.broken]\nenv = { API_KEY = "${SECRET_LITERAL}" }\nbroken = [\n`,
      'utf-8',
    );
    await fs.mkdir(path.join(homeDir, '.claude.json'), { recursive: true });

    const result = await planExternalMcpImport({});
    const bySource = Object.fromEntries(result.files.map((file) => [file.sourceId, file]));

    expect(bySource['claude-code'].status).toBe('unreadable');
    expect(bySource['claude-code'].error).toContain('read failed');
    expect(bySource['cursor'].status).toBe('invalid');
    expect(bySource['cursor'].error).toContain('invalid JSON');
    expect(bySource['codex'].status).toBe('invalid');
    expect(bySource['codex'].error).toContain('invalid TOML');
    expect(bySource['claude-desktop'].status).toBe('missing');
    expect(result.items).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET_LITERAL);
    expect(capturedLogs()).not.toContain(SECRET_LITERAL);
  });

  it('非对象条目与非数组 args 都明确按 invalid-entry 跳过；既有同名同配置/不同配置正确区分', async () => {
    await writeFullFixtureHome();
    await fs.writeFile(
      path.join(dataDir, 'mcp.json'),
      JSON.stringify({
        servers: [
          { name: 'github', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], enabled: false },
          { name: 'filesystem', type: 'stdio', command: 'other-command', enabled: true },
        ],
      }),
      'utf-8',
    );
    const conflictCheck = await planExternalMcpImport({});
    expect(itemByName(conflictCheck.items, 'github', 'claude-code').reason).toBe('already-exists');
    expect(itemByName(conflictCheck.items, 'filesystem').reason).toBe('name-conflict');

    await fs.writeFile(path.join(homeDir, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: {
        'bad-shape': 'not-an-object',
        'bad-args': { command: 'npx', args: 'not-an-array' },
      },
    }));
    const badResult = await planExternalMcpImport({ sourceIds: ['cursor'] });
    expect(badResult.items.map((item) => [item.name, item.reason])).toEqual([
      ['bad-shape', 'invalid-entry'],
      ['bad-args', 'invalid-entry'],
    ]);
  });
});

describe('applyExternalMcpImport & mcp.ipc apply：落盘、泄密、幂等（验收②③⑤）', () => {
  it('全部以 enabled:false 写入用户 mcp.json，secret 值零落盘/零回传/零日志（验收②③）', async () => {
    await writeFullFixtureHome();
    const res = await invokeMcpIpc('externalImportMcpApply', {});
    expect(res.success).toBe(true);
    const result = res.data as ExternalMcpApplyResult;

    expect(result.imported).toBe(6);
    expect(result.skipped).toBe(4);
    expect(result.targetPath).toBe(path.join(dataDir, 'mcp.json'));

    const written = await fs.readFile(path.join(dataDir, 'mcp.json'), 'utf-8');
    expect(written.includes(SECRET_LITERAL)).toBe(false);

    const preview = await planExternalMcpImport({});
    expect(JSON.stringify(result).includes(SECRET_LITERAL)).toBe(false);
    expect(JSON.stringify(preview).includes(SECRET_LITERAL)).toBe(false);
    expect(capturedLogs().includes(SECRET_LITERAL)).toBe(false);

    expect(itemByName(result.items, 'github', 'claude-code').neededEnvKeys).toEqual(['GITHUB_TOKEN']);

    const parsed = JSON.parse(written) as { servers: Array<{ name: string; enabled: boolean }> };
    expect(parsed.servers.map((server) => [server.name, server.enabled]).sort()).toEqual([
      ['filesystem', false],
      ['github', false],
      ['notion', false],
      ['sentinel-remote', false],
      ['sentry', false],
      ['websearch', false],
    ]);
    expect(runtimeAddServer).toHaveBeenCalledTimes(6);
    for (const [server] of runtimeAddServer.mock.calls) {
      expect(server).toMatchObject({ enabled: false, scope: 'user' });
      expect(JSON.stringify(server)).not.toContain(SECRET_LITERAL);
    }

    const servers = (await loadMcpConfigFiles()) as Array<{
      name: string; env?: Record<string, string>; headers?: Record<string, string>;
    }>;
    expect(servers.find((s) => s.name === 'github')?.env).toBeUndefined();
    expect(servers.find((s) => s.name === 'websearch')?.env).toEqual({ FETCH_TIMEOUT: '5000' });
    expect(servers.find((s) => s.name === 'sentinel-remote')?.headers).toEqual({ 'X-Client': 'neo-import-test' });
    expect(servers.find((s) => s.name === 'sentry')?.headers).toBeUndefined();
  });

  it('导入两次第二次零新增；跨来源同 server 只导入一次（验收⑤）', async () => {
    await writeFullFixtureHome();
    const first = await applyExternalMcpImport({});
    expect(first.imported).toBe(6);

    const second = await applyExternalMcpImport({});
    expect(second.imported).toBe(0);
    expect(second.items.filter((item) => item.action === 'imported')).toEqual([]);
    expect(second.items.filter((item) => item.reason === 'already-exists')).toHaveLength(6);
    expect(second.items.filter((item) => item.reason === 'source-disabled')).toHaveLength(2);
    expect(second.items.filter((item) => item.reason === 'duplicate-across-sources')).toHaveLength(1);
    expect(second.items.filter((item) => item.reason === 'placeholder-in-command')).toHaveLength(1);

    const written = JSON.parse(await fs.readFile(path.join(dataDir, 'mcp.json'), 'utf-8')) as {
      servers: unknown[];
    };
    expect(written.servers.length).toBe(6);
  });
});

describe('detectExternalImportSources & countExternalMcpImportCandidates：检测页 MCP 计数', () => {
  it('四来源给出各自 MCP 候选计数；无配置文件时不出 mcp 类别 chip；坏文件候选数为 0', async () => {
    await writeFullFixtureHome();
    const detected = await detectExternalImportSources({} as never);
    const mcpCount = (id: string) =>
      detected.sources.find((s) => s.sourceId === id)?.categories.find((c) => c.category === 'mcp')?.count;

    expect(mcpCount('claude-code')).toBe(2);
    expect(mcpCount('claude-desktop')).toBe(1);
    expect(mcpCount('cursor')).toBe(2);
    expect(mcpCount('codex')).toBe(2);

    const bareHome = path.join(tmpRoot, 'bare-home');
    await fs.mkdir(bareHome, { recursive: true });
    expect(await countExternalMcpImportCandidates('cursor', bareHome)).toEqual({ filePresent: false, count: 0 });

    await fs.writeFile(path.join(homeDir, '.cursor', 'mcp.json'), 'nope', 'utf-8');
    expect(await countExternalMcpImportCandidates('cursor', homeDir)).toEqual({ filePresent: true, count: 0 });
  });
});
