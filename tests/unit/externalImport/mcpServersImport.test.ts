// ============================================================================
// mcpServersImport 单测（N-EXTHISTORY-IMPORT-K1B-MCP）
// ============================================================================
//
// 覆盖验收①③④的 host 半：
// ① 四来源真实形状夹具（含 env_http_headers 的 TOML 样本、${GITHUB_TOKEN} 的 JSON
//    样本）全部读出；坏文件给文件级原因，绝不静默空列表。
// ③ 泄密测试：对写盘文件、IPC 结果 JSON、捕获的 logger 输出 grep 夹具 secret 字面量
//    （sk-FIXTURE-SECRET-123）零命中；结果行给出「needs <KEY>」。
// ④ 幂等：导入两次第二次零新增；同 server 双来源只导入一次。
// 另钉：enabled:false 恒写、${...} 命令整条跳过、来源已停用跳过、per-project 条目
// 不读、既有同名同配置/同名不同配置的区分。

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET_LITERAL = 'sk-FIXTURE-SECRET-123';

/** 捕获 logger 输出（泄密测试要 grep 宿主日志面）。 */
const logSink: string[] = [];
const capturedLogs = () => logSink.join('\n');

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

const runtimeAddServer = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/mcp/mcpClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/mcp/mcpClient')>()),
  getMCPClient: () => ({
    getServerStates: () => [],
    addServer: runtimeAddServer,
  }),
}));

// persistServerDefault 动态 import mcp.ipc：与 mcp.domain.ipc.test.ts 同款最小 mock。
vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getMcpCatalog: () => [] }),
}));

import {
  applyExternalMcpImport,
  countExternalMcpImportCandidates,
  planExternalMcpImport,
} from '../../../src/host/externalImport/mcpServersImport';
import { loadMcpConfigFiles } from '../../../src/host/mcp/mcpConfigFile';

let tmpRoot: string;
let homeDir: string;
let dataDir: string;

beforeEach(async () => {
  logSink.length = 0;
  runtimeAddServer.mockReset();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'external-mcp-import-'));
  homeDir = path.join(tmpRoot, 'home');
  dataDir = path.join(tmpRoot, 'data');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  vi.stubEnv('CODE_AGENT_HOME', homeDir);
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** 四来源真实形状夹具。 */
async function writeFullFixtureHome(): Promise<void> {
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
          // 与 claude.json 的 github 同 command+args：跨来源重复，只导入一次。
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
          },
          notion: {
            command: 'npx',
            args: ['-y', '@notionhq/notion-mcp-server'],
            // Cursor Notion 真实形状：值内嵌 Authorization 的序列化 header 表。
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
      'env = { "FETCH_TIMEOUT" = "5000", "API_SECRET_TOKEN" = "' + SECRET_LITERAL + '" }',
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

describe('planExternalMcpImport：四来源读取与安全映射（验收①）', () => {
  it('四来源全部读出并按安全规则映射；per-project 条目不读', async () => {
    await writeFullFixtureHome();
    const result = await planExternalMcpImport({});

    // 文件级报告：四个来源全部 ok。
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
    expect(github.sourceId).toBe('claude-code'); // 跨来源重复时先出现的来源赢

    // cursor 的 github 是重复项：skip + duplicate-across-sources。
    const dup = result.items.find(
      (item) => item.name === 'github' && item.sourceId === 'cursor',
    );
    expect(dup?.disposition).toBe('skip');
    expect(dup?.reason).toBe('duplicate-across-sources');

    // 值内嵌 Authorization 的 OPENAPI_MCP_HEADERS：剥值记名。
    const notion = itemByName(result.items, 'notion');
    expect(notion.disposition).toBe('import');
    expect(notion.neededEnvKeys).toEqual(['OPENAPI_MCP_HEADERS']);

    // command/args 含 ${...} → 整条跳过。
    expect(itemByName(result.items, 'db-placeholder').reason).toBe('placeholder-in-command');

    // 来源标记 disabled/enabled:false → 跳过。
    expect(itemByName(result.items, 'context7-disabled').reason).toBe('source-disabled');
    expect(itemByName(result.items, 'observability').reason).toBe('source-disabled');

    // 远程：Authorization 头剥掉记名，benign 头保留（写入面在 apply 里验）。
    const sentry = itemByName(result.items, 'sentry');
    expect(sentry.disposition).toBe('import');
    expect(sentry.kind).toBe('remote');
    expect(sentry.commandSummary).toBe('https://mcp.sentry.dev/sse');
    expect(sentry.neededEnvKeys).toEqual(['Authorization']);

    // Desktop stdio：benign env 原样保留（随写入面验证）。
    const filesystem = itemByName(result.items, 'filesystem');
    expect(filesystem.disposition).toBe('import');
    expect(filesystem.neededEnvKeys).toEqual([]);

    // Codex stdio：secret 值剥掉；env_vars 名字进 needed；benign env 保留。
    const websearch = itemByName(result.items, 'websearch');
    expect(websearch.disposition).toBe('import');
    expect(websearch.commandSummary).toBe('uvx mcp-server-fetch');
    expect(websearch.neededEnvKeys).toEqual(['API_SECRET_TOKEN', 'OPENAI_API_KEY']);

    // Codex 远程：bearer_token_env_var / env_http_headers 只记名字；benign 头保留。
    const sentinel = itemByName(result.items, 'sentinel-remote');
    expect(sentinel.disposition).toBe('import');
    expect(sentinel.kind).toBe('remote');
    expect(sentinel.neededEnvKeys).toEqual(['SENTINEL_API_VERSION', 'SENTINEL_TOKEN']);

    // ~/.claude.json per-project 的 mcpServers 不导入。
    expect(result.items.some((item) => item.name === 'project-only')).toBe(false);

    expect(result.summary.import).toBe(6);
    expect(result.summary.skip).toBe(4);
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
    // 路径是目录（非 root 环境也稳定触发 read 失败，不依赖 chmod 语义）。
    await fs.mkdir(path.join(homeDir, '.claude.json'), { recursive: true });

    const result = await planExternalMcpImport({});
    const bySource = Object.fromEntries(result.files.map((file) => [file.sourceId, file]));

    expect(bySource['claude-code'].status).toBe('unreadable');
    expect(bySource['claude-code'].error).toContain('read failed');
    expect(bySource['cursor'].status).toBe('invalid');
    expect(bySource['cursor'].error).toContain('invalid JSON');
    expect(bySource['codex'].status).toBe('invalid');
    expect(bySource['codex'].error).toContain('invalid TOML');
    // 文件缺失是信息项（missing），有独立原因文案。
    expect(bySource['claude-desktop'].status).toBe('missing');
    expect(result.items).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET_LITERAL);
    expect(capturedLogs()).not.toContain(SECRET_LITERAL);
  });

  it('非对象条目与非数组 args 都明确按 invalid-entry 跳过', async () => {
    await fs.mkdir(path.join(homeDir, '.cursor'), { recursive: true });
    await fs.writeFile(path.join(homeDir, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: {
        'bad-shape': 'not-an-object',
        'bad-args': { command: 'npx', args: 'not-an-array' },
      },
    }));

    const result = await planExternalMcpImport({ sourceIds: ['cursor'] });
    expect(result.items.map((item) => [item.name, item.reason])).toEqual([
      ['bad-shape', 'invalid-entry'],
      ['bad-args', 'invalid-entry'],
    ]);
  });

  it('Neo 已有同名同配置 → already-exists；同名不同配置 → name-conflict', async () => {
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

    const result = await planExternalMcpImport({});
    expect(itemByName(result.items, 'github', 'claude-code').reason).toBe('already-exists');
    expect(itemByName(result.items, 'filesystem').reason).toBe('name-conflict');
  });
});

describe('applyExternalMcpImport：落盘、泄密、幂等（验收②③④）', () => {
  it('全部以 enabled:false 写入用户 mcp.json，secret 值零落盘/零回传/零日志（验收③）', async () => {
    await writeFullFixtureHome();
    const result = await applyExternalMcpImport({});

    expect(result.imported).toBe(6);
    expect(result.skipped).toBe(4);
    expect(result.targetPath).toBe(path.join(dataDir, 'mcp.json'));

    const written = await fs.readFile(path.join(dataDir, 'mcp.json'), 'utf-8');

    // ③-a 写盘文件零命中
    expect(written.includes(SECRET_LITERAL)).toBe(false);

    // ③-b IPC 结果（preview + apply）零命中
    const preview = await planExternalMcpImport({});
    expect(JSON.stringify(result).includes(SECRET_LITERAL)).toBe(false);
    expect(JSON.stringify(preview).includes(SECRET_LITERAL)).toBe(false);

    // ③-c 捕获的 logger 输出零命中
    expect(capturedLogs().includes(SECRET_LITERAL)).toBe(false);

    // ③-d 结果行给出「needs <KEY>」
    expect(itemByName(result.items, 'github', 'claude-code').neededEnvKeys).toEqual(['GITHUB_TOKEN']);

    // ② 写入的 server 全部 enabled:false（一个不漏）
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

    // 写入形状细节：github 的 env 整个不写（唯一成员是 secret）；websearch 保留 benign env。
    const servers = (await loadMcpConfigFiles()) as Array<{
      name: string; env?: Record<string, string>; headers?: Record<string, string>;
    }>;
    const github = servers.find((server) => server.name === 'github');
    expect(github?.env).toBeUndefined();
    const websearch = servers.find((server) => server.name === 'websearch');
    expect(websearch?.env).toEqual({ FETCH_TIMEOUT: '5000' });
    const sentinel = servers.find((server) => server.name === 'sentinel-remote');
    expect(sentinel?.headers).toEqual({ 'X-Client': 'neo-import-test' });
    const sentry = servers.find((server) => server.name === 'sentry');
    expect(sentry?.headers).toBeUndefined();
  });

  it('导入两次第二次零新增；写入条数不变（验收④）', async () => {
    await writeFullFixtureHome();
    const first = await applyExternalMcpImport({});
    expect(first.imported).toBe(6);

    const second = await applyExternalMcpImport({});
    expect(second.imported).toBe(0);
    expect(second.items.filter((item) => item.action === 'imported')).toEqual([]);
    // 第一轮导入的 6 条全部 already-exists；来源侧本来就跳过的条目维持原原因。
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

describe('countExternalMcpImportCandidates：检测页计数', () => {
  it('文件存在给候选数；文件缺失 filePresent=false；坏文件 filePresent=true 但 count=0', async () => {
    await writeFullFixtureHome();
    expect(await countExternalMcpImportCandidates('claude-code', homeDir)).toEqual({ filePresent: true, count: 2 });
    expect(await countExternalMcpImportCandidates('claude-desktop', homeDir)).toEqual({ filePresent: true, count: 1 });
    // cursor 自己的 github/notion 都算候选（跨来源去重是预览阶段的事）。
    expect(await countExternalMcpImportCandidates('cursor', homeDir)).toEqual({ filePresent: true, count: 2 });
    expect(await countExternalMcpImportCandidates('codex', homeDir)).toEqual({ filePresent: true, count: 2 });

    const bareHome = path.join(tmpRoot, 'bare-home');
    await fs.mkdir(bareHome, { recursive: true });
    expect(await countExternalMcpImportCandidates('cursor', bareHome)).toEqual({ filePresent: false, count: 0 });

    await fs.writeFile(path.join(homeDir, '.cursor', 'mcp.json'), 'nope', 'utf-8');
    expect(await countExternalMcpImportCandidates('cursor', homeDir)).toEqual({ filePresent: true, count: 0 });
  });
});
