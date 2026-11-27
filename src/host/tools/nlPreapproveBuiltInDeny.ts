// ============================================================================
// N-PERM-NL-RULES-K2：preapprove（「我说了才做」）命中触发短语前的最后一问——
// 内置分类规则对这条调用是硬拒（chmod 777 / kill -1 / 递归删关键路径 …）吗？
//
// preapprove 命中会并入 isPreApproved、整段跳过审批链，而内置硬拒就在那段里。
// 规则只能免掉「问一下」，不能放宽内置闸：是硬拒就不算命中，调用照常进审批链，
// 由那里的分类器按无规则时的同一口径拒掉。
//
// 只跑规则段（不调 LLM）：这里只问确定性的内置规则；每次新建实例，不带跨调用缓存。
// ============================================================================

import { PermissionClassifier, type ClassificationContext } from './permissionClassifier';
import { createLogger } from '../services/infra/logger';
import { matchEffectiveExecPolicy } from '../permissions/runPolicySnapshot';
import type { ToolLedgerOrigin } from '../../shared/constants/toolLedger';
import { recordDecision } from './toolExecutorDecisionTrace';
import { isBashToolName } from './toolNames';
import type { ToolExecutionResult } from './types';

const logger = createLogger('NlPreapproveBuiltInDeny');

export async function builtInRulesDeny(
  toolName: string,
  params: Record<string, unknown>,
  context: ClassificationContext,
): Promise<boolean> {
  try {
    const result = await new PermissionClassifier({ enableLlm: false }).classify(toolName, params, context);
    if (result.decision !== 'deny') return false;
    logger.info('nl_preapprove_not_applied', { tool: toolName, cause: 'builtin_deny', reason: result.reason });
    return true;
  } catch (error) {
    // 判不出来按「会拒」处理：不免卡，交回审批链。
    logger.warn('nl_preapprove_not_applied', {
      tool: toolName,
      cause: 'builtin_check_failed',
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

/** A phrase can waive the ordinary question. An explicit exec policy still wins. */
export function nlPreapprovalExecPolicy(
  toolName: string, command: unknown, sessionId?: string, runId?: string,
): 'forbidden' | 'prompt' | null {
  if (!isBashToolName(toolName) || typeof command !== 'string' || !command) return null;
  try {
    const decision = matchEffectiveExecPolicy(command, sessionId, runId);
    return decision === 'allow' ? null : decision;
  } catch (error) {
    logger.warn('NL preapproval could not check exec policy', { error: String(error) });
    return 'prompt';
  }
}

export function denyByExecPolicy(
  toolName: string, params: Record<string, unknown>, startTime: number,
  sessionId: string | undefined, origin: ToolLedgerOrigin,
): ToolExecutionResult {
  recordDecision(toolName, params, 'policy-deny', 'exec-policy', startTime, undefined, sessionId, origin);
  return { success: false, error: `Blocked by exec policy: ${String(params.command).substring(0, 80)}` };
}
