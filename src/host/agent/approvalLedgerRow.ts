import type { PermissionRequest } from '../../shared/contract';
import type { PendingApprovalKind, ToolApprovalPayload } from '../../shared/contract/pendingApproval';
import { PARKED_APPROVAL_PREVIEW_MAX_CHARS } from '../../shared/constants/pendingApproval';
import { pickApprovalOrigin } from '../permissions/approvalOriginFields';
import { redactCommandSecrets } from '../security/secretRedaction';
import type { InsertPendingApprovalInput } from '../services/core/repositories/PendingApprovalRepository';
import { isExternalSideEffectTool } from '../tools/externalSideEffect';
import { terminalApprovalPreviewText } from '../tools/modules/terminal/terminalApprovalPreview';

/**
 * 后台任务/子代理 lane 的审批带着自己的 run 身份（subagentToolRuntime 把
 * { agentId, runId } 摊进请求；前台请求两者皆无）。run 收线清理据此放过它们
 * （N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO）。
 */
export function hasBackgroundRunIdentity(request: PermissionRequest): boolean {
  return (typeof request.runId === 'string' && request.runId.length > 0)
    || (typeof request.agentId === 'string' && request.agentId.length > 0);
}

/**
 * 停车审批的参数预览（N-PARKED-APPROVAL-SURVIVE-RESTART-PERSIST）：argsSummary 的取值字段
 * 加上 url/changes，脱敏后截断。这里只去密钥形态（redactSecrets：API key / Bearer / .env 值），
 * 不走 guardSensitiveText 的路径/邮箱掩码——路径与命令本体正是「这步要干什么」要给用户看的信息。
 */
export function buildParkedArgsPreview(request: PermissionRequest): string | undefined {
  const parts = [
    request.details?.command,
    terminalApprovalPreviewText(request.tool, request.details?.preview),
    request.details?.path,
    request.details?.filePath,
    request.details?.url,
    request.details?.changes,
    // 事件回复（N-TRIGGER-OBSERVE-ACTION-CONTRACT-DESIGN）：参数摘要显示「会发出的正文」。
    request.details?.replyText,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0);
  if (parts.length === 0) return undefined;
  const redacted = redactCommandSecrets(parts.join(' · '));
  return redacted.length > PARKED_APPROVAL_PREVIEW_MAX_CHARS
    ? `${redacted.slice(0, PARKED_APPROVAL_PREVIEW_MAX_CHARS - 1)}…`
    : redacted;
}

export function buildApprovalLedgerRow(
  fullRequest: PermissionRequest,
  permissionLevel: string,
  kind: PendingApprovalKind,
  argsPreview: string | undefined,
  writeGrantFolder?: string,
): InsertPendingApprovalInput & { payload: ToolApprovalPayload } {
  const isDirectoryAccess = kind === 'directory_access';
  // 跨重启引用只在两个 id 都真实在时写；messageId 权限路径上没有真源，不填（不许发明）。
  const argsRef = fullRequest.sessionId && fullRequest.parentToolUseId
    ? { sessionId: fullRequest.sessionId, toolCallId: fullRequest.parentToolUseId }
    : undefined;
  const argsSummaryRaw = fullRequest.details?.command
    ?? fullRequest.details?.path
    ?? fullRequest.details?.filePath
    ?? fullRequest.details?.url;
  const payload: ToolApprovalPayload = {
    sessionId: fullRequest.sessionId ?? null,
    ...(fullRequest.parentToolUseId ? { toolCallId: fullRequest.parentToolUseId } : {}),
    tool: fullRequest.tool,
    type: fullRequest.type,
    permissionLevel,
    ...(fullRequest.forceConfirm === true ? { forceConfirm: true } : {}),
    ...(hasBackgroundRunIdentity(fullRequest) ? { backgroundLane: true as const } : {}),
    ...pickApprovalOrigin(fullRequest.details),
    requestedAt: fullRequest.timestamp,
    argsSummary: argsSummaryRaw === undefined ? undefined : redactCommandSecrets(argsSummaryRaw),
    ...(argsRef ? { argsRef } : {}),
    // 跨重启存活原料（N-PARKED-APPROVAL-SURVIVE-RESTART-RESUME）：指纹 + 忠实标记由
    // toolExecutor 随请求上抛；不忠实（台账形 ≠ 原始 args）的行照写数据，判据侧拦。
    ...(argsRef && fullRequest.argsFingerprint
      ? {
        argsFingerprint: fullRequest.argsFingerprint,
        ledgerFaithful: fullRequest.ledgerFaithful === true,
      }
      : {}),
    ...(argsPreview ? { argsPreview } : {}),
    ...(writeGrantFolder ? { writeGrantFolder } : {}),
    // ADR-088 敏感步骤交回：收件箱/会话卡据此渲染单状态交回卡（展示元数据，无秘密本体）。
    ...(fullRequest.details?.sensitiveStep
      ? { sensitiveStep: fullRequest.details.sensitiveStep }
      : {}),
    // 目录授权卡直接给人话："访问 <path>（只读/读写）· <agent 理由>"，不用通用 tool 名。
    displayTool: isDirectoryAccess
      ? `目录访问：${fullRequest.details?.path ?? '(unknown path)'}（${
          fullRequest.details?.requestedAccess === 'read_write' ? '读写' : '只读'
        }）${fullRequest.reason ? `· ${fullRequest.reason}` : ''}`
      // 事件回复（N-TRIGGER-OBSERVE-ACTION-CONTRACT-DESIGN）：卡上点名宿主绑定的去向
      // （群名），不裸奔工具内部名；正文在 argsPreview（参数行）。
      : typeof fullRequest.details?.replyDestination === 'string' && fullRequest.details.replyDestination
        ? `回复 ${fullRequest.details.replyDestination}`
        : undefined,
    riskClass: isExternalSideEffectTool(fullRequest.tool) ? 'external' : null,
    // B4：external+可提取 target 时非空 → 收件箱审批卡出「每次都允许发 <target>」铸权入口。
    standingGrantTarget: fullRequest.details?.standingGrantTarget ?? null,
    ...(fullRequest.details.targetApp ? { targetApp: fullRequest.details.targetApp } : {}),
    ...(fullRequest.details.browserSessionGrant ? { browserSessionGrant: fullRequest.details.browserSessionGrant, displayAction: fullRequest.reason } : {}),
  };
  return {
    id: fullRequest.id,
    kind,
    agentId: null,
    agentName: null,
    coordinatorId: fullRequest.sessionId ?? null,
    payload,
    submittedAt: fullRequest.timestamp,
  };
}
