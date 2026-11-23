// ============================================================================
// 「查询前免确认」开关（permissions.readOnlyProbePlan）对前台列目录类查询的约束。
// 开关关 → ListDirectory / Glob 不再被只读白名单自动放行，必须出审批卡；
// 开关开（默认）→ 本模块不改变任何行为。Read / Grep 等其余工具不受影响。
// ============================================================================

import type { ClassificationResult } from './permissionClassifier';
import { isReadOnlyProbeEnabled } from './readOnlyProbeHook';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ReadOnlyLookupAsk');
const LOOKUP_TOOLS = new Set(['ListDirectory', 'list_directory', 'Glob', 'glob']);

export function readOnlyLookupMustAsk(toolName: string): boolean {
  if (!LOOKUP_TOOLS.has(toolName) || isReadOnlyProbeEnabled()) return false;
  logger.info('readonly_lookup_ask', { tool: toolName });
  return true;
}

export function askInsteadOfApprove(result: ClassificationResult, forced: boolean): ClassificationResult {
  if (!forced || result.decision !== 'approve') return result;
  return { ...result, decision: 'ask', reason: `read-only lookups need confirmation (switch off): ${result.reason ?? ''}` };
}
