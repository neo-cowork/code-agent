// ============================================================================
// mcpServerLabel —— MCP 工具名解析与 server 人话口径的共享层（FB-2291）
//
// humanizeToolStep（步骤行）、ToolCallDisplay/getToolDisplayName（工具标签）、
// toolHumanLabel/getHumanToolLabel（审批卡/右栏）三处共用同一套解析与命名，
// 谁都不许把 `mcp__cua-driver__list_apps` 原文或内部 server slug 拼给用户。
// ============================================================================

// mcp 工具命名：现行 mcp__server__tool（双下划线），历史遗留 mcp_server_tool（单下划线）。
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const idx = rest.indexOf('__');
    if (idx > 0) return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
    return null;
  }
  const legacy = name.match(/^mcp_([^_]+)_(.+)$/);
  if (legacy) return { server: legacy[1], tool: legacy[2] };
  return null;
}

// 已知 MCP server 的显示名映射。命中走 Title Case 友好名，未命中按 hyphen-case
// 自动转 Title Case 兜底（如 my-server → My Server）。新增 server 不需要改这里
// 也能正常显示，只是命中映射表的会更精致（如 chrome-devtools → Chrome DevTools）。
const MCP_SERVER_DISPLAY_NAMES: Record<string, string> = {
  'better-icons': 'Better Icons',
  'chrome-devtools': 'Chrome DevTools',
  'computer-use': 'Computer Use',
  'deepwiki': 'DeepWiki',
  'exa': 'Exa',
  'firecrawl': 'Firecrawl',
  'github': 'GitHub',
  'memory': 'Memory',
  'obsidian': 'Obsidian',
  'pencil': 'Pencil',
};

export function formatMcpServerName(serverSlug: string): string {
  const known = MCP_SERVER_DISPLAY_NAMES[serverSlug];
  if (known) return known;
  // 兜底：hyphen/underscore-case → Title Case
  return serverSlug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// cua-driver 是内置的 Computer Use 后端：步骤行与标签都复用 computer 域既有
// 人话（「查看了电脑状态」「操作了电脑」），server slug 本身不与用户见面。
// （旧底座 argus 仅 CODE_AGENT_ENABLE_ARGUS_MCP=1 时注册，工具面不同，不在本单范围。）
export function isComputerUseMcpServer(server: string): boolean {
  return server === 'cua-driver';
}

/**
 * server slug 是否不宜拼进步骤行：已知友好 server（见 MCP_SERVER_DISPLAY_NAMES）
 * 与即时通讯频道名（飞书/Slack…）照旧；目录连接器在调用方更早短路。其余 slug
 * 只有在名字本身是个干净词时才原样出现——带 - / _ 或纯数字的内部噪声一律
 * 隐藏，走通用「执行工具操作」句。
 */
export function shouldHideMcpServerSlug(
  server: string,
  channelNames: Record<string, string> | undefined,
): boolean {
  if (MCP_SERVER_DISPLAY_NAMES[server]) return false;
  if (channelNames?.[server]) return false;
  return /[-_]/u.test(server) || /^\d+$/u.test(server);
}
