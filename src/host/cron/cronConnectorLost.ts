// ============================================================================
// cronConnectorLost —— 无人值守运行发现连接器登录丢失 → 待过目收件箱记一条（同连接器同日至多一条）
// ============================================================================
// 两个来源（都只认 CONFIRMED 信号，见 docs/architecture/connector-lost-login-signals.md）：
//   ① 运行前预检：任务角色声明的 CLI 连接器，探测缓存带 lostReason；
//   ② 运行后扫描：工具结果带 MCP 401 标记（mcpAuthorizationRequired）。
// 去重键 = 连接器 + 本地日历日（eventId `connector_lost:<连接器>:<YYYY-MM-DD>`）：进程内集合 +
// 记录上 pendingReview.connectorLost.days 双保险。时钟由调用方注入，这里不读系统时间。
// 文案面向用户：只写连接器显示名，不写 id / 错误码。
// ============================================================================

import type { CronJobDefinition } from '../../shared/contract/cron';
import type { Message } from '../../shared/contract/message';
import { CLI_CONNECTOR_DESCRIPTORS } from '../../shared/constants/cliConnectorDescriptors';
import { resolveSessionConnectorIds } from '../../shared/contract/expertConnectors';
import { resolveAgent } from '../agent/agentRegistry';
import { MCP_AUTHORIZATION_REQUIRED_METADATA_KEY } from '../mcp/mcpErrors';
import { getCachedCliConnectorConnectionStatus, isCliConnectorId } from '../connectors/cli/cliConnectorStatusCache';
import { getSessionAutomationService } from '../services/sessionAutomation';
import { getCronAutomationType } from './cronAutomationBridge';

const recordedKeys = new Set<string>();

function localDayKey(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function displayName(connectorId: string): string {
  return CLI_CONNECTOR_DESCRIPTORS.find((item) => item.id === connectorId)?.displayName ?? connectorId;
}

/** 运行前预检：任务角色声明的 CLI 连接器里，探测确认登录丢失的 id。 */
export function precheckLostCliConnectors(roleId: string | undefined): string[] {
  if (!roleId) return [];
  const ids = resolveSessionConnectorIds({ expertConnectors: resolveAgent(roleId)?.connectors });
  return ids.filter((id) => isCliConnectorId(id) && getCachedCliConnectorConnectionStatus(id)?.lostReason);
}

/** 运行后扫描：工具结果里带 MCP 401 标记的服务器名。 */
export function scanLostMcpConnectors(messages: readonly Pick<Message, 'toolResults'>[]): string[] {
  const found = new Set<string>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      const metadata = result.metadata as Record<string, unknown> | undefined;
      if (result.success || !metadata?.[MCP_AUTHORIZATION_REQUIRED_METADATA_KEY]) continue;
      const server = metadata.serverName ?? metadata.server;
      if (typeof server === 'string' && server) found.add(server);
    }
  }
  return [...found];
}

/** 每个（连接器, 本地日）至多一条收件箱记录；失败只记日志，不影响运行结果。 */
export async function recordCronConnectorLost(
  definition: CronJobDefinition,
  connectorIds: readonly string[],
  now: () => number,
): Promise<void> {
  const nowMs = now();
  const day = localDayKey(nowMs);
  for (const connectorId of new Set(connectorIds)) {
    const eventId = `connector_lost:${connectorId}:${day}`;
    if (recordedKeys.has(eventId)) continue;
    try {
      const service = getSessionAutomationService();
      const type = getCronAutomationType(definition);
      const existing = service.getBySourceRef(type, definition.id);
      const previous = existing?.config?.pendingReview?.connectorLost;
      if (previous?.days[connectorId] === day) {
        recordedKeys.add(eventId);
        continue;
      }
      const summary = `今天的定时运行没能读取「${displayName(connectorId)}」：它当前未登录。请在聊天或设置里重新连接后再运行。`;
      const recorded = await service.recordEvent({
        type,
        sourceRefId: definition.id,
        event: 'completed',
        status: 'pending_review', // 回流消息标题显示「待过目」；记录自身状态由 recordStatus 钉住不变
        recordStatus: existing?.status,
        summary,
        configPatch: {
          pendingReview: {
            ...(existing?.config?.pendingReview ?? {}),
            at: nowMs,
            connectorLost: { days: { ...(previous?.days ?? {}), [connectorId]: day }, summary },
          },
        },
        eventId,
      });
      if (recorded) recordedKeys.add(eventId);
    } catch (error) {
      console.error('[CronService] Failed to record connector-lost automation event:', error);
    }
  }
}
