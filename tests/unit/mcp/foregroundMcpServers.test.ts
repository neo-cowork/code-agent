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

import {
  BUILTIN_MCP_SERVER_NAMES,
  getForegroundMcpServerIds,
  selectForegroundMcpServerIds,
} from '../../../src/host/mcp/foregroundMcpServers';
import { getDefaultMCPServers } from '../../../src/host/mcp/mcpDefaultServers';
import type { MCPConfigScope } from '../../../src/host/mcp/types';

const cfg = (name: string, scope: MCPConfigScope, enabled = true) => ({ name, scope, enabled });

describe('selectForegroundMcpServerIds', () => {
  it('只收 user scope、已启用、且不在内置默认名单里的服务器', () => {
    expect(selectForegroundMcpServerIds([
      cfg('external-import-nonce', 'user'),
      cfg('disabled-import', 'user', false),
      cfg('cua-driver', 'builtin'),
      cfg('deepwiki', 'builtin'),
      cfg('github', 'user'),
      cfg('from-repo', 'project'),
      cfg('local-one', 'local'),
      cfg('cloud-one', 'cloud'),
      cfg('runtime-one', 'runtime'),
    ], BUILTIN_MCP_SERVER_NAMES)).toEqual(['external-import-nonce']);
  });

  it('BUILTIN_MCP_SERVER_NAMES 覆盖 getDefaultMCPServers 返回的每一个内置服务器名', () => {
    for (const server of getDefaultMCPServers()) {
      expect(BUILTIN_MCP_SERVER_NAMES.has(server.name), server.name).toBe(true);
    }
  });
});

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
});
