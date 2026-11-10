// ============================================================================
// declare_deliverables — 最终产物路径声明工具
//
// 声明记账在 messageProcessor 里（recordDeclareDeliverables，能拿到 RuntimeContext）；
// 本 executor 取回记账结果作为自己的工具结果返回，事件与落库一致。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { declareDeliverablesSchema as schema } from './declareDeliverables.schema';
import { takeDeclareOutcome } from './declareDeliverablesOutcomeStore';

export async function executeDeclareDeliverables(
  _args: Record<string, unknown>,
  ctx: ToolContext,
  _canUseTool: CanUseToolFn,
  _onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const outcome = takeDeclareOutcome(ctx.sessionId, ctx.currentToolCallId);
  if (!outcome) return { ok: true, output: '已收到最终产物声明。' };
  return outcome.success
    ? { ok: true, output: outcome.text }
    : { ok: false, error: outcome.text };
}

class DeclareDeliverablesHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeDeclareDeliverables(args, ctx, canUseTool, onProgress);
  }
}

export const declareDeliverablesModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new DeclareDeliverablesHandler();
  },
};
