// ============================================================================
// 真人审批应答 → 授权记忆（铸造策略单一真源）
// 在线路径（OrchestratorPermissionIsland）与重启恢复路径（parkedApprovalResume）
// 共用这一份：拒绝铸造的判据（ADR-088 / 可编辑 / forceConfirm / 无 target external）
// 只在此处维护，不许在调用方各抄一份。
// ============================================================================

import type { PermissionRequest, PermissionResponse } from '../../shared/contract';
import { PermissionRequestReason } from '../../shared/contract/permission';
import { isEditableTool } from '../../shared/contract/permissionEdit';
import { getConfirmationGate } from '../agent/confirmationGate';
import { createLogger } from '../services/infra/logger';
import { isExternalSideEffectTool } from '../tools/externalSideEffect';
import { mintAppGrantSession, mintAppGrantStanding } from './appGrantStore';
import { recordBrowserSessionGrant } from './browserSessionGrant';
import { connectorToolGrantIdentity } from './connectorToolAccess';
import { mintTool24hGrant, mintToolRunGrant } from './toolGrantStore';

const logger = createLogger('HumanGrantPolicy');

/** 真人点的会话/始终/两档工具授权。带 targetApp 时只记该应用，不记工具级放行。
 * plain allow 不记。allow_run/allow_24h 铸进 toolGrantStore（target 取透传的
 * standingGrantTarget，无 target 的工具级授权不放大到任何去向）。
 * 带 updatedArgs 的非 allow 应答会被 toAskResult 整体 fail-closed 拒——那种应答
 * 不铸造任何记忆：用户审的是改后内容，拒绝它不能换算成对原稿的任何档位授权。
 * `now`：24h 档的 grantedAt（重启恢复路径传注入时钟；在线路径缺省走 store 默认）。 */
export function recordHumanGrant(
  response: PermissionResponse,
  request: PermissionRequest,
  updatedArgs?: Record<string, unknown>,
  now?: number,
): void {
  // ADR-088 §4 三层保证之 3（host 侧永不铸造）：敏感步骤交回的应答**整体**跳过铸造——
  // 包括 allow_session 在无 targetApp 时回落 recordApproval 的会话级工具放行记录
  // （那同样是本流程不许产生的授权）。任何形态的记住应答都降级为一次性语义。
  if (
    request.reasonCode === PermissionRequestReason.SensitiveStepHandback
    || request.details?.sensitiveStep
  ) {
    logger.warn('Sensitive step hand-back answer never mints a grant', {
      tool: request.tool,
      response,
    });
    return;
  }
  if (updatedArgs && response !== 'allow') return;
  // 与聊天卡 hideStandingGrants 等价的收口：可编辑写回工具 / forceConfirm / 无 target 的 external
  // 只能一次性放行，两档工具授权（run/24h）一律不铸，避免收件箱点击放大成全局免审。
  if (
    (response === 'allow_run' || response === 'allow_24h')
    && (
      isEditableTool(request.tool)
      || request.forceConfirm === true
      || (isExternalSideEffectTool(request.tool) && !request.details?.standingGrantTarget)
    )
  ) {
    logger.warn('Tier grant refused for editable/forceConfirm/untargeted-external request: treated as allow once', {
      tool: request.tool,
      requestId: request.id,
      response,
    });
    return;
  }
  if (recordBrowserSessionGrant(response, request)) {
    if (response === 'allow_24h') {
      logger.warn('24h tier grant not available for browser tools: treated as allow once', {
        tool: request.tool,
        requestId: request.id,
      });
    }
    return;
  }
  const identity = connectorToolGrantIdentity(request.tool, request.details?.standingGrantTarget ?? null);
  if (!identity) return;
  const app = request.details?.targetApp;
  if (response === 'allow_session' && request.sessionId) {
    if (app?.name) mintAppGrantSession(request.sessionId, app);
    else getConfirmationGate().recordApproval(request.sessionId, request.tool);
  } else if (response === 'allow_standing' && app?.name) {
    mintAppGrantStanding(app);
  } else if (response === 'allow_run' && !app?.name) {
    // run 档没有会话就无处归属（重启恢复/无会话应答）：不落任何记忆，warn 留痕，
    // 下一次同类调用照常询问——fail-safe 而非静默放大成全局。
    if (!request.sessionId) {
      logger.warn('allow_run response without sessionId: run-tier grant not minted, next call will ask again', {
        tool: request.tool,
        requestId: request.id,
      });
    } else {
      mintToolRunGrant(request.sessionId, identity.tool, identity.target);
    }
  } else if (response === 'allow_24h' && !app?.name) {
    mintTool24hGrant(identity.tool, identity.target, now);
  } else if (response === 'allow_24h') {
    logger.warn('24h tier grant not minted for computer-use app target: treated as allow once', {
      tool: request.tool,
      requestId: request.id,
      targetApp: app?.name,
    });
  }
}
