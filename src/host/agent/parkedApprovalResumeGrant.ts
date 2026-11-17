// ============================================================================
// 重启后点「24 小时内允许」：认领赢家补铸档位授权
// 铸造策略与在线路径同一份（permissions/humanGrantPolicy）；这里只负责用行 payload +
// 台账调用参数重建最小 PermissionRequest。targetApp 不落盘，从台账参数重推。
// ============================================================================

import type { PermissionRequest, PermissionResponse } from '../../shared/contract';
import type { ToolApprovalPayload } from '../../shared/contract/pendingApproval';
import { extractComputerTargetApp } from '../permissions/computerAppTarget';
import { recordHumanGrant } from '../permissions/humanGrantPolicy';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ParkedApprovalResume');

export function applyGrantAfterRestartClaim(input: {
  response: PermissionResponse;
  requestId: string;
  payload: ToolApprovalPayload;
  sessionId: string;
  ledgerArgs: Record<string, unknown>;
  now: number;
}): void {
  const { response, requestId, payload, sessionId, ledgerArgs, now } = input;
  if (response === 'allow_run') {
    // 重启后没有 run 可归属：只放行这一次，不落任何记忆。
    logger.warn('allow_run after restart: approved once, no run to attribute after restart, run-tier grant not minted', {
      requestId,
      tool: payload.tool,
    });
    return;
  }
  if (response !== 'allow_24h') return;
  const targetApp = extractComputerTargetApp(payload.tool, ledgerArgs);
  const request = {
    id: requestId,
    sessionId,
    tool: payload.tool,
    type: payload.type,
    forceConfirm: payload.forceConfirm,
    details: {
      action: typeof ledgerArgs.action === 'string' ? ledgerArgs.action : undefined,
      standingGrantTarget: payload.standingGrantTarget ?? undefined,
      sensitiveStep: payload.sensitiveStep,
      browserSessionGrant: payload.browserSessionGrant,
      targetApp: targetApp ?? undefined,
    },
  } as PermissionRequest;
  recordHumanGrant(response, request, undefined, now);
}
