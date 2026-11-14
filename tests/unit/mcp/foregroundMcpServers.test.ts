import { describe, expect, it } from 'vitest';
import { BUILTIN_MCP_SERVER_NAMES, selectForegroundMcpServerIds } from '../../../src/host/mcp/foregroundMcpServers';
import { getDefaultMCPServers } from '../../../src/host/mcp/mcpDefaultServers';
import type { MCPConfigScope } from '../../../src/host/mcp/types';

const state = (name: string, scope: MCPConfigScope, enabled = true) => (
  { config: { name, scope, enabled } } as never
);
const BUILTIN = new Set(['cua-driver', 'argus', 'deepwiki', 'github']);

describe('selectForegroundMcpServerIds', () => {
  it('只收 user scope、已启用、且不在内置默认名单里的服务器', () => {
    const ids = selectForegroundMcpServerIds([
      state('external-import-nonce', 'user'),
      state('disabled-import', 'user', false),
      state('cua-driver', 'builtin'),
      state('deepwiki', 'builtin'),
      state('github', 'user'), // 与内置同名：仍走委派
      state('from-repo', 'project'),
      state('local-one', 'local'),
      state('cloud-one', 'cloud'),
      state('runtime-one', 'runtime'),
    ], BUILTIN);
    expect(ids).toEqual(['external-import-nonce']);
  });
});

describe('BUILTIN_MCP_SERVER_NAMES', () => {
  it('覆盖 getDefaultMCPServers 返回的每一个内置服务器名', () => {
    for (const server of getDefaultMCPServers()) {
      expect(BUILTIN_MCP_SERVER_NAMES.has(server.name), server.name).toBe(true);
    }
  });
});
