// ============================================================================
// Declare Deliverables Gate — 拦截 declare_deliverables 写入最终产物契约
// ============================================================================

import type { ToolCall, ToolResult } from '../../../shared/contract';
import type { RuntimeContext } from './runtimeContext';
import {
  stashDeclareOutcome,
  type DeclareDeliverablesOutcome,
} from '../../tools/modules/planning/declareDeliverablesOutcomeStore';

function formatPathList(paths: string[]): string {
  return paths.map((item) => `- ${item}`).join('\n');
}

function formatScratchDir(scratchDir: string | undefined): string {
  return scratchDir ? scratchDir : '(未声明)';
}

function buildRejectionMessage(reason: string): string {
  return [
    `declare_deliverables 声明已拒绝：${reason}。`,
    '请重新调用 declare_deliverables，并提供非空的 final_artifacts 字符串数组。',
  ].join('\n');
}

function validateArguments(args: Record<string, unknown> | undefined): {
  ok: true;
  finalArtifacts: string[];
  scratchDir?: string;
} | {
  ok: false;
  reason: string;
} {
  const rawFinalArtifacts = args?.final_artifacts;
  if (!Array.isArray(rawFinalArtifacts)) {
    return { ok: false, reason: 'final_artifacts 必须是非空字符串数组' };
  }

  const finalArtifacts = rawFinalArtifacts.filter((item): item is string => typeof item === 'string');
  if (finalArtifacts.length !== rawFinalArtifacts.length || finalArtifacts.length === 0) {
    return { ok: false, reason: 'final_artifacts 不能为空，且每一项都必须是字符串' };
  }

  const rawScratchDir = args?.scratch_dir;
  if (rawScratchDir !== undefined && typeof rawScratchDir !== 'string') {
    return { ok: false, reason: 'scratch_dir 必须是字符串' };
  }

  return { ok: true, finalArtifacts, scratchDir: rawScratchDir };
}

/**
 * 只做 declare_deliverables 的副作用：写入 RuntimeContext.artifact.declaredDeliverables，
 * 算出确认/拒绝文本。不再提前结束本轮——调用本身随整批走普通「落库 + 执行」链路，
 * 执行完用 applyDeclareDeliverablesOutcome 把结果盖成确认文本，模型下一轮能看到自己的调用和结果。
 *
 * 必须在 unavailable-tool admission 之后调用（admission 自愈重试轮会重发整批，提前记录会重复记账）。
 *
 * @returns 以 toolCallId 为键的结果；本批没有 declare_deliverables 时为 null。
 */
export function recordDeclareDeliverables(
  ctx: RuntimeContext,
  toolCalls: ToolCall[],
): Map<string, DeclareDeliverablesOutcome> | null {
  const declarationCalls = toolCalls.filter((tc) => tc.name === 'declare_deliverables');
  if (declarationCalls.length === 0) return null;

  const outcomes = new Map<string, DeclareDeliverablesOutcome>();
  for (const declarationCall of declarationCalls) {
    const validation = validateArguments(declarationCall.arguments);
    if (!validation.ok) {
      ctx.turnTrace?.record('deliverables_declaration', {
        status: 'rejected',
        reason: validation.reason,
      });
      const rejected = { success: false, text: buildRejectionMessage(validation.reason) };
      outcomes.set(declarationCall.id, rejected);
      stashDeclareOutcome(ctx.sessionId, declarationCall.id, rejected);
      continue;
    }

    const previous = ctx.artifact.declareDeliverables({
      finalArtifacts: validation.finalArtifacts,
      scratchDir: validation.scratchDir,
      declaredAtMs: Date.now(),
    });

    ctx.turnTrace?.record('deliverables_declaration', {
      status: previous ? 'overridden' : 'declared',
      finalArtifacts: validation.finalArtifacts,
      scratchDir: validation.scratchDir ?? null,
      previous: previous ? {
        finalArtifacts: previous.finalArtifacts,
        scratchDir: previous.scratchDir ?? null,
        declaredAtMs: previous.declaredAtMs,
      } : null,
    });

    const text = [
      previous ? '已覆盖之前的声明。' : '已记录最终产物声明。',
      '最终产物：',
      formatPathList(validation.finalArtifacts),
      `草稿目录：${formatScratchDir(validation.scratchDir)}`,
      previous ? [
        '--- 之前的声明 ---',
        '最终产物：',
        formatPathList(previous.finalArtifacts),
        `草稿目录：${formatScratchDir(previous.scratchDir)}`,
      ].join('\n') : '',
      '后续写入、验证和收尾请对齐本声明；如最终路径需要变更，请先重新调用 declare_deliverables。',
    ].filter(Boolean).join('\n');
    outcomes.set(declarationCall.id, { success: true, text });
    stashDeclareOutcome(ctx.sessionId, declarationCall.id, { success: true, text });
  }
  return outcomes;
}

/** executor 没取到记账结果时的兜底：把成功结果盖成运行时记录的确认/拒绝文本（就地改写 results）。 */
export function applyDeclareDeliverablesOutcome(
  results: ToolResult[],
  outcomes: Map<string, DeclareDeliverablesOutcome> | null,
): void {
  if (!outcomes) return;
  for (const result of results) {
    const outcome = outcomes.get(result.toolCallId);
    // 引擎在 executor 之前已失败（参数校验 / hook 拦截）：事件已按那条失败发出，不再改写，保持事件与落库一致。
    if (!outcome || !result.success) continue;
    result.success = outcome.success;
    if (outcome.success) {
      result.output = outcome.text;
      delete result.error;
    } else {
      result.error = outcome.text;
      delete result.output;
    }
  }
}
