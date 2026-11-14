// 文字前台 brain（ADR-059）可直接触达的 MCP 服务器：只认用户自己的配置。
// 条件同时满足才进名单：scope === 'user'（导入或手写进 ~/.code-agent/mcp.json，
// 不含 builtin / cloud / project / local / runtime）、当前启用、名字不在内置默认服务器里
// （cua-driver / argus / deepwiki / github 等照旧只走委派）。
// 纯函数的 policy 叶子模块不能 import MCP 注册表，所以这里算好 id 再显式传入。
import { getMCPClient } from './mcpClient';
import { CUA_DRIVER_SERVER_NAME } from './types';
import type { MCPServerState } from './types';

// 内置默认服务器名（与 mcpDefaultServers.getDefaultMCPServers 同步，漂移由单测守住）。
// 静态列出而不是运行时调 getDefaultMCPServers：后者读 configService/环境，前台装配路径不该依赖它。
export const BUILTIN_MCP_SERVER_NAMES: ReadonlySet<string> = new Set([
  CUA_DRIVER_SERVER_NAME, 'argus', 'deepwiki', 'filesystem', 'git', 'github', 'sqlite',
  'brave-search', 'memory', 'sequential-thinking', 'puppeteer', 'docker',
]);

export function selectForegroundMcpServerIds(
  states: readonly Pick<MCPServerState, 'config'>[],
  builtinNames: ReadonlySet<string>,
): string[] {
  return states
    .filter(({ config }) => config.scope === 'user' && config.enabled !== false && !builtinNames.has(config.name))
    .map(({ config }) => config.name);
}

export function getForegroundMcpServerIds(): string[] {
  return selectForegroundMcpServerIds(getMCPClient().getServerStates(), BUILTIN_MCP_SERVER_NAMES);
}
