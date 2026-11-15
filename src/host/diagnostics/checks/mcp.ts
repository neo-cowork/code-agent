// ============================================================================
// Doctor Check - MCP Server 状态
// 5 态映射：
//   - connected   → pass
//   - lazy        → skip（懒加载未触发，不计入 fail）
//   - connecting  → warn（卡在中间态）
//   - disconnected→ warn（用户主动断开或冷启动未连接）
//   - error       → fail
// 注意：本检查**不**主动触发 ensureConnected，避免 doctor 产生副作用。
// ============================================================================

import { DOCTOR_FIX_CODES } from '../../../shared/constants/doctor';
import type { DoctorFixCode } from '../../../shared/constants/doctor';
import { getMCPClient } from '../../mcp/mcpClient';
import type { MCPServerStatus } from '../../mcp/types';
import type { DoctorItem, DoctorStatus } from '../types';
import { doctorCopy } from '../i18n/doctorCopy';

type McpDoctorCopy = ReturnType<typeof doctorCopy>['mcp'];

const statusMapFor = (copy: McpDoctorCopy): Record<MCPServerStatus, {
  status: DoctorStatus;
  label: string;
  suggestion?: string;
  fixCode?: DoctorFixCode;
}> => ({
  connected: { status: 'pass', label: copy.connected },
  lazy: {
    status: 'skip',
    label: copy.lazy,
  },
  connecting: {
    status: 'warn',
    label: copy.connecting,
    suggestion: copy.connectingSuggestion,
    fixCode: DOCTOR_FIX_CODES.OPEN_MCP_SETTINGS,
  },
  disconnected: {
    status: 'warn',
    label: copy.disconnected,
    suggestion: copy.disconnectedSuggestion,
    fixCode: DOCTOR_FIX_CODES.OPEN_MCP_SETTINGS,
  },
  error: {
    status: 'fail',
    label: copy.error,
    suggestion: copy.errorSuggestion,
    fixCode: DOCTOR_FIX_CODES.OPEN_MCP_SETTINGS,
  },
});

export function checkMcpServers(): DoctorItem[] {
  const client = getMCPClient();
  const states = client.getServerStates();

  if (states.length === 0) {
    return [
      {
        category: 'mcp',
        name: 'MCP servers',
        status: 'skip',
        message: doctorCopy().mcp.noServers,
      },
    ];
  }

  const statusMap = statusMapFor(doctorCopy().mcp);
  return states.map((state): DoctorItem => {
    const mapping = statusMap[state.status];
    const detailParts: string[] = [];
    if (state.toolCount > 0) detailParts.push(`${state.toolCount} tools`);
    if (state.resourceCount > 0) detailParts.push(`${state.resourceCount} resources`);
    if (state.error) detailParts.push(`error: ${state.error}`);

    return {
      category: 'mcp',
      name: state.config.name,
      status: mapping.status,
      message: detailParts.length > 0
        ? `${mapping.label} · ${detailParts.join(' · ')}`
        : mapping.label,
      details: state.error,
      suggestion: mapping.suggestion,
      fix: mapping.fixCode ? { code: mapping.fixCode } : undefined,
    };
  });
}
