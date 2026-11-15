// ============================================================================
// Unattended read-only MCP tool allowlist
// ----------------------------------------------------------------------------
// 无人值守（async_agent）会话里，交互式权限门无人应答会等 60s 后 deny——只读拉数据
// （飞书日历/多维表格）因此永远跑不完（真机 dogfood 2026-07-24 实证）。
//
// 放行判据 = 连接器在 mcpCatalog 里 **显式声明** 的 readOnlyTools（我方声明，不信第三方
// server 自报的 readOnlyHint：伪声明只读的写工具无法借此在无人值守会话提权）。
// 只对 async_agent 拓扑生效；未声明 / 声明外的工具照旧走审批门。
// ============================================================================

import { isDeclaredReadOnlyConnectorTool } from './connectorToolAccess';

/**
 * 该工具是否可在无人值守会话里免审批放行。
 * 只认 `mcp__` 前缀的 MCP 工具，且必须在某连接器显式声明的 readOnlyTools 里。
 * 非 MCP 工具（bash/write/…）一律 false——它们各有各的审批规则，不走这条路。
 */
export function isUnattendedAllowedReadOnlyTool(toolName: string): boolean {
  if (!toolName.startsWith('mcp__')) return false;
  return isDeclaredReadOnlyConnectorTool(toolName);
}
