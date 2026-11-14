// ============================================================================
// roleOwnMemoryAllow — 无人值守角色醒来写「自己的」角色层记忆的窄放行
//（N-ROLE-WAKE-OWN-MEMORY-NO-APPROVAL）
// ============================================================================
// 裁定（owner 11-12）：无人值守醒来写自己的角色层记忆不需要审批卡——发起者就是
// 角色本人，产物用户可见、可在记忆面板逐条删除（RoleDetailPage 每条记忆有删除
// 按钮）。此前这条路径在 toolExecutor 主分类分支落成 file_write 审批卡，无人值守
// 会话里没有人能点它，醒来实例整轮挂死（realrun54 #08）。
//
// 本判定只放宽这一个形状，其余一切照旧走审批：
// - global / user / project scope：不放行（global 仍先过 directive 记忆确认门）
// - type === 'directive'：不放行（指令类记忆永远需要用户确认）
// - action === 'delete'：不放行
// - 任何非 MemoryWrite 工具：不放行
// - 非无人值守会话（交互会话）：不放行，路径与今天完全一致
//
// 判据全部来自 host 侧真源：roleId 只取执行上下文传入的 agentRole（subagentExecutor
// / toolExecutionEngine 灌入），绝不采信模型自报的 scope 之外的任何身份字段；
// 「无人值守」取 PermissionModeManager.isUnattendedSession（cron/heartbeat/channel
// 会话创建收口处标记；角色醒来会话 origin.kind='cron'，两路醒来都命中）。
// 位置约束：调用点在 toolExecutor 主分类分支之前，所有硬拒路径（policy deny /
// exec-policy forbidden / 用户拒绝 sticky / peer-origin 无人值守拒 / 记忆目录
// directive 门）都更早，本放行不触及它们。
// ============================================================================

import { getPermissionModeManager } from '../permissions/modes';
import { memoryWriteSchema } from './modules/lightMemory/memoryWrite.schema';

/** 记忆写入判定的 reason 码，落 permission ledger 供审计区分来源。 */
export const ROLE_OWN_MEMORY_UNATTENDED_REASON = 'role-own-memory-unattended';

/**
 * 本次 MemoryWrite 调用是否命中「无人值守会话写自己角色层记忆」的窄放行形状。
 *
 * scope 解析词法与 memoryWrite.ts 的 resolveScopedTarget 同源：
 * - scope 'role' → 角色层（必须有 agentRole，否则 handler 自己会拒）
 * - scope 缺省且有 agentRole → 角色层（MemoryWrite 对持久化角色的默认层）
 * - 其余（'global' / 'user' / 'project' / 未知值）→ 不属于本放行
 */
export function isUnattendedRoleOwnMemoryWrite(input: {
  toolName: string;
  params: Record<string, unknown>;
  agentRole: string | undefined;
  sessionId: string | undefined;
}): boolean {
  const { toolName, params, agentRole, sessionId } = input;
  if (toolName !== memoryWriteSchema.name) return false;
  if (params.action !== 'write') return false;
  if (params.type === 'directive') return false;
  if (!agentRole) return false;
  const scope = typeof params.scope === 'string' ? params.scope : undefined;
  const resolvesToOwnRoleLayer = scope === 'role' || scope === undefined;
  if (!resolvesToOwnRoleLayer) return false;
  return getPermissionModeManager().isUnattendedSession(sessionId);
}
