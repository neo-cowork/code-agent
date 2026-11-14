// ============================================================================
// Foreground MCP Servers — 文字前台用户已启用 MCP 服务器范围解析
// （N-EXTHISTORY-IMPORT-K1B-MCP-REDESIGN）
// ============================================================================
//
// 从用户级 mcp.json 配置文件读取已启用的非内置服务器，注入现有
// toolScope.allowedMcpServerIds 通道（无需修改 runToolPolicy / toolRunPolicy）：
//   1. 只看配置文件（不依赖当前连接状态），并在本轮推理前按需连接，保证重启后首轮即达。
//   2. 内置默认服务器（BUILTIN_MCP_SERVER_NAMES）与 in-process 服务器一律排除，
//      维持 ADR-059 文字前台收窄语义。
//   3. 用户或专家已在本轮显式指定 toolScope.allowedMcpServerIds 时原样保留显式范围。

import { MCP_TIMEOUTS } from '../../shared/constants/timeouts';
import type { WorkbenchToolScope } from '../../shared/contract/conversationEnvelope';
import { createLogger } from '../services/infra/logger';
import { normalizeWorkbenchToolScope } from '../tools/workbenchToolScope';
import { loadMcpConfigFiles } from './mcpConfigFile';
import { CUA_DRIVER_SERVER_NAME, type MCPServerConfig } from './types';

const logger = createLogger('ForegroundMcpServers', { lane: 'mcp' });

/** 内置默认服务器名（与 mcpDefaultServers.getDefaultMCPServers 对齐，单测防漂移）。 */
const BUILTIN_MCP_SERVER_NAMES: ReadonlySet<string> = new Set([
  CUA_DRIVER_SERVER_NAME,
  'argus',
  'deepwiki',
  'filesystem',
  'git',
  'github',
  'sqlite',
  'brave-search',
  'memory',
  'sequential-thinking',
  'puppeteer',
  'docker',
  'memory-kv',
  'code-index',
]);

function selectEnabledUserMcpConfigs(configs: readonly MCPServerConfig[]): MCPServerConfig[] {
  return configs.filter(
    (config) => config.scope === 'user'
      && config.enabled !== false
      && config.type !== 'in-process'
      && !BUILTIN_MCP_SERVER_NAMES.has(config.name),
  );
}

export async function resolveForegroundMcpToolScope(
  toolScope?: WorkbenchToolScope,
  options?: { preconnect?: boolean },
): Promise<WorkbenchToolScope | undefined> {
  // 不传 workingDirectory：只读 user scope，不触发 project/local 的 folder-trust 判定。
  const enabledUserConfigs = selectEnabledUserMcpConfigs(await loadMcpConfigFiles());
  const explicitIds = toolScope?.allowedMcpServerIds?.filter(Boolean) ?? [];
  const allowedMcpServerIds = explicitIds.length > 0
    ? explicitIds
    : enabledUserConfigs.map((config) => config.name);

  if (allowedMcpServerIds.length === 0) {
    return toolScope;
  }

  if (options?.preconnect !== false) {
    const allowedSet = new Set(allowedMcpServerIds);
    const toPreconnect = enabledUserConfigs.filter((config) => allowedSet.has(config.name));
    if (toPreconnect.length > 0) {
      try {
        const { getMCPClient } = await import('./mcpClient');
        const client = getMCPClient();
        for (const config of toPreconnect) {
          try {
            if (!client.getServerState(config.name)) {
              client.addServer(config);
            }
            await client.ensureConnected(config.name, AbortSignal.timeout(MCP_TIMEOUTS.SSE_CONNECT));
          } catch (error) {
            logger.warn('Foreground user MCP server preconnect failed (non-blocking)', {
              serverName: config.name,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        logger.warn('MCP client unavailable during foreground scope resolution', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return normalizeWorkbenchToolScope({
    ...(toolScope ?? {}),
    allowedMcpServerIds,
  });
}
