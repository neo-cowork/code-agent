import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../src/host/config/configPaths', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/config/configPaths')>('../../../src/host/config/configPaths');
  return {
    ...actual,
    getMcpScopedConfigPaths: () => ({ user: path.join(home.dir, 'mcp.json'), project: null, local: null }),
  };
});

import { getForegroundMcpServerIds } from '../../../src/host/mcp/foregroundMcpServers';
import { getDefaultMCPServers } from '../../../src/host/mcp/mcpDefaultServers';

describe('getForegroundMcpServerIds（读配置文件，不看连接状态）', () => {
  beforeEach(async () => { home.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-mcp-')); });
  afterEach(async () => { await fs.rm(home.dir, { recursive: true, force: true }); });

  it('(a) 已启用的导入服务器在 MCP client 完全没注册/没连接时也在名单里', async () => {
    await fs.writeFile(path.join(home.dir, 'mcp.json'), JSON.stringify({ servers: [
      { name: 'external-import-nonce', type: 'stdio', command: 'node', args: ['x.mjs'], enabled: true },
    ] }));
    expect(await getForegroundMcpServerIds()).toEqual(['external-import-nonce']);
  });

  it('(b) 禁用的导入服务器与内置默认同名条目被排除；文件缺失得到空名单', async () => {
    await fs.writeFile(path.join(home.dir, 'mcp.json'), JSON.stringify({ servers: [
      { name: 'imported-off', type: 'stdio', command: 'node', enabled: false },
      { name: 'deepwiki', type: 'stdio', command: 'node', enabled: true },
      { name: 'cua-driver', type: 'stdio', command: 'node', enabled: true },
      { name: 'sequential-thinking', type: 'stdio', command: 'node', enabled: true },
    ] }));
    expect(await getForegroundMcpServerIds()).toEqual([]);
    await fs.rm(path.join(home.dir, 'mcp.json'));
    expect(await getForegroundMcpServerIds()).toEqual([]);
  });

  it('内置名单覆盖 getDefaultMCPServers 的每一个名字（防漂移）：全部以 user 条目写入也一个不进名单', async () => {
    const servers = [
      ...getDefaultMCPServers().map((server) => ({ name: server.name, type: 'stdio', command: 'node', enabled: true })),
      { name: 'cua-driver', type: 'stdio', command: 'node', enabled: true },
      { name: 'argus', type: 'stdio', command: 'node', enabled: true },
      { name: 'user-own', type: 'stdio', command: 'node', enabled: true },
    ];
    await fs.writeFile(path.join(home.dir, 'mcp.json'), JSON.stringify({ servers }));
    expect(await getForegroundMcpServerIds()).toEqual(['user-own']);
  });
});
