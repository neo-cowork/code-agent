// ============================================================================
// 问用户之前的授权消费：先按应用，再按工具授权两档（run/24h），最后按既有 external
// 长期授权。硬门（blocked）一律不消费。分类器 deny 在调用方更早返回，这里碰不到。
// ============================================================================

import { getSessionAutomationService } from '../services/sessionAutomation/sessionAutomationService';
import { matchAppGrant } from './appGrantStore';
import { appGrantKey, type ComputerTargetApp } from './computerAppTarget';
import { connectorToolGrantIdentity } from './connectorToolAccess';
import { matchToolGrant } from './toolGrantStore';

export function resolvePreAskGrant(input: {
  toolName: string;
  sessionId: string | undefined;
  standingGrantTarget: string | null;
  computerApp: ComputerTargetApp | null;
  browserSessionTarget?: string | null;
  blocked: boolean;
}): { ledgerReason: string; traceRule: string; traceDetail: string } | null {
  if (input.blocked) return null;
  if (input.computerApp && matchAppGrant(input.sessionId ?? '', input.computerApp)) {
    return {
      ledgerReason: `app_grant:${appGrantKey(input.computerApp)}`,
      traceRule: 'app_grant',
      traceDetail: `app grant hit: ${input.computerApp.name}`,
    };
  }
  // N-PERM-GRANT-TIERS：host 侧工具授权两档。target 精确一致（null 只匹配 null），
  // run 档只在授权所属会话内命中。排在 standingGrants 之前：时间盒比永久授权窄。
  if (input.browserSessionTarget === null) return null;
  const identity = connectorToolGrantIdentity(input.toolName, input.browserSessionTarget ?? input.standingGrantTarget);
  const toolGrantTier = matchToolGrant(input.sessionId, identity.tool, identity.target);
  if (toolGrantTier) {
    return {
      ledgerReason: `tool_grant:${toolGrantTier}`,
      traceRule: `tool_grant:${toolGrantTier}`,
      traceDetail: toolGrantTier === 'session' ? 'Session approval matched this action and site' : toolGrantTier === 'run'
        ? `任务内授权命中：${input.toolName}`
        : `24 小时授权命中：${input.toolName}`,
    };
  }
  if (!input.standingGrantTarget) return null;
  const hit = getSessionAutomationService().matchStandingGrant(
    input.sessionId,
    input.toolName,
    input.standingGrantTarget,
  );
  if (!hit) return null;
  return {
    ledgerReason: `standing_grant:${input.standingGrantTarget}`,
    traceRule: 'standing_grant',
    traceDetail: `长期授权命中：${input.toolName} → ${input.standingGrantTarget}`,
  };
}
