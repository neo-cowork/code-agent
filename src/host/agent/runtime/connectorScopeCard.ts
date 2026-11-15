// ============================================================================
// connectorScopeCard —— MCP 工具因权限范围不足失败时，给聊天发一张「重新授权」连接卡
// ============================================================================
// 工具失败的 ToolResult.metadata 带 mcpInsufficientScope（mcpClient 写入）；引擎在 tool_call_end
// 之后调这里，把它转成 connector_required(reason:'insufficient_scope')。每次失败的工具调用至多一张，
// 事件走 ctx.onEvent，agentAppService 与 web routes/agent 两条发射路径共用。
// helpUrl 只来自「已核实官方权限页」表，表里没有就不带。
// ============================================================================

import type { AgentEvent, ToolResult } from '../../../shared/contract';
import { getMcpPermissionPageUrl, MCP_PERMISSION_PAGE_URLS } from '../../../shared/constants';
import { MCP_AUTHORIZATION_REQUIRED_METADATA_KEY, MCP_INSUFFICIENT_SCOPE_METADATA_KEY } from '../../mcp/mcpErrors';

function buildInsufficientScopeConnectorEvent(
  result: Pick<ToolResult, 'success' | 'metadata'>,
  permissionPages: Readonly<Record<string, string>> = MCP_PERMISSION_PAGE_URLS,
): AgentEvent | null {
  if (result.success) return null;
  const metadata = result.metadata as Record<string, unknown> | undefined;
  const info = metadata?.[MCP_INSUFFICIENT_SCOPE_METADATA_KEY];
  if (!info || typeof info !== 'object') return null;
  const server = metadata?.serverName ?? metadata?.server;
  if (typeof server !== 'string' || !server) return null;
  const { requiredScope } = info as { requiredScope?: unknown };
  const helpUrl = getMcpPermissionPageUrl(server, permissionPages);
  return {
    type: 'connector_required',
    data: {
      connectors: [{
        id: server,
        source: 'selected',
        reason: 'insufficient_scope',
        ...(typeof requiredScope === 'string' && requiredScope ? { requiredScope } : {}),
        ...(helpUrl ? { helpUrl } : {}),
      }],
    },
  };
}

/**
 * MCP 401（服务端要求重新授权）→ connector_required(reason:'lost_login')。
 * 401 不区分过期与撤销，所以只带 mcp_oauth_authorization_required，卡片文案只说「需要重新授权」。
 * 每次失败的工具调用至多一张；与 insufficient_scope 互斥（同一失败只会带其中一个标记）。
 */
function buildLostLoginConnectorEvent(
  result: Pick<ToolResult, 'success' | 'metadata'>,
): AgentEvent | null {
  if (result.success) return null;
  const metadata = result.metadata as Record<string, unknown> | undefined;
  if (!metadata?.[MCP_AUTHORIZATION_REQUIRED_METADATA_KEY]) return null;
  const server = metadata.serverName ?? metadata.server;
  if (typeof server !== 'string' || !server) return null;
  return {
    type: 'connector_required',
    data: {
      connectors: [{
        id: server,
        source: 'selected',
        reason: 'lost_login',
        lostCode: 'mcp_oauth_authorization_required',
      }],
    },
  };
}

/** 工具失败 → 连接卡事件（权限范围不足优先，其次登录丢失）；两处发射点（引擎 / 子代理）共用。 */
export function buildConnectorToolFailureEvent(
  result: Pick<ToolResult, 'success' | 'metadata'>,
  permissionPages: Readonly<Record<string, string>> = MCP_PERMISSION_PAGE_URLS,
): AgentEvent | null {
  return buildInsufficientScopeConnectorEvent(result, permissionPages) ?? buildLostLoginConnectorEvent(result);
}
