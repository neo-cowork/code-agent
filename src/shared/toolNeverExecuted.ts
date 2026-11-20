import { AgentFailureCode, HostReasonCode } from './contract';

// Denied-for-approval-reasons host codes: the operation reached the permission layer and was
// rejected there (classifier/policy/hard-gate/timeout/cancel), as opposed to no approval UI
// existing at all (PermissionDeniedNoApprovalUi, handled separately below).
export const APPROVAL_REQUIRED_HOST_CODES: ReadonlySet<HostReasonCode> = new Set([
  // 用户自己的 deny 规则也是权限层硬拒（evaluateGuardFabricGate → evaluateUserDeny）：
  // 工具在执行前被拦下，什么都没写。不认它的话 ToolHeader 把这类行当普通失败渲染，
  // 标题仍是「打开预览」按钮——点开一个从未写出的文件，右栏红字「failed to load
  // file」（N-FIX-PREFLIGHT-UNWRITTEN-TITLE-OPEN-PREVIEW-FAIL-FU1）。失败原因行不受
  // 影响：humanizeToolFailureReason 先查 hostReason 登记表，出「被你设置的权限规则
  // 拦下了」的登记文案，不会落到这里的 approvalRequired「需要人工确认」。
  HostReasonCode.PermissionDeniedUserRule,
  HostReasonCode.PermissionClassifierDenied,
  HostReasonCode.PermissionHighRiskActionBlocked,
  HostReasonCode.PermissionUnregisteredActionBlocked,
  HostReasonCode.PermissionCommandAnalysisFailed,
  HostReasonCode.PermissionClassifierFailed,
  HostReasonCode.PermissionDeniedByUser,
  HostReasonCode.PermissionDeniedTimeout,
  HostReasonCode.PermissionDeniedCancelled,
  HostReasonCode.PermissionDeniedFailClosed,
  HostReasonCode.PermissionDeniedScripted,
]);

/** Structural subset of ToolResult the predicate reads (keeps host/renderer call sites free of casts). */
interface NeverExecutedProbe {
  success?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * One shared judgement of "this tool call never ran": a bounced/skipped/permission-denied call.
 * A command that ran (metadata.executed === true) and failed is NOT never-executed.
 */
export function isToolResultNeverExecuted(result: NeverExecutedProbe | undefined | null): boolean {
  if (!result || result.success === true) return false;
  const metadata = result.metadata;
  if (!metadata || metadata.executed === true) return false;
  if (metadata.skipped === true || metadata.bounced === true) return true;
  if (metadata.failureCode === AgentFailureCode.PermissionDenied) return true;
  const hostCode = (metadata.hostReason as { code?: string } | undefined)?.code;
  return Boolean(hostCode) && (
    hostCode === HostReasonCode.PermissionDeniedNoApprovalUi
    || APPROVAL_REQUIRED_HOST_CODES.has(hostCode as HostReasonCode)
  );
}
