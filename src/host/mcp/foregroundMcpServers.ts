// 文字前台 brain（ADR-059）可直接触达的 MCP 服务器：只认用户自己的配置。
// 名单从「已启用的 user-scope 配置」算（与 MCPClient 初始化用的是同一个加载器
// loadMcpConfigFiles，读 ~/.code-agent/mcp.json），不看连接/注册状态：
// 重启后第一轮服务器还在异步注册时，名单照样完整，ToolSearch 不会被误裁。
// 条件同时满足才进名单：scope === 'user'（不含 builtin / cloud / project / local / runtime）、
// 配置里启用、名字不在内置默认服务器里（cua-driver / argus / deepwiki / github 等照旧只走委派）。
// 纯函数的 policy 叶子模块不能 import MCP 注册表，所以这里算好 id 再显式传入。
import { loadMcpConfigFiles } from './mcpConfigFile';
import { CUA_DRIVER_SERVER_NAME } from './types';
import type { MCPServerConfig } from './types';

// 内置默认服务器名（与 mcpDefaultServers.getDefaultMCPServers 同步，漂移由单测守住）。
// 静态列出而不是运行时调 getDefaultMCPServers：后者读 configService/环境，前台装配路径不该依赖它。
export const BUILTIN_MCP_SERVER_NAMES: ReadonlySet<string> = new Set([
  CUA_DRIVER_SERVER_NAME, 'argus', 'deepwiki', 'filesystem', 'git', 'github', 'sqlite',
  'brave-search', 'memory', 'sequential-thinking', 'puppeteer', 'docker',
]);

export function selectForegroundMcpServerIds(
  configs: readonly Pick<MCPServerConfig, 'name' | 'scope' | 'enabled'>[],
  builtinNames: ReadonlySet<string>,
): string[] {
  return configs
    .filter((config) => config.scope === 'user' && config.enabled !== false && !builtinNames.has(config.name))
    .map((config) => config.name);
}

export async function getForegroundMcpServerIds(): Promise<string[]> {
  // 不传 workingDirectory：只读 user scope，不触发 project/local 的 folder-trust 判定。
  return selectForegroundMcpServerIds(await loadMcpConfigFiles(), BUILTIN_MCP_SERVER_NAMES);
}
