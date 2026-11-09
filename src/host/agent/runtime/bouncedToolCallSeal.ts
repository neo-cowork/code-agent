// ============================================================================
// sealBouncedToolCalls — 门把整批工具调用打回（不执行）时，把调用和结果补进历史
//
// 背景：goal 闸 / artifact 修复闸早退 'continue' 时，模型本轮发出的 tool_use 既没落库也没有
// tool_result，下一轮上下文里这些调用凭空消失，模型不知道自己做过什么、只会原样重发
// （dogfood：MiMo 33 批被吞）。写法对齐 handleUnavailableToolCalls / forceFinalSeal：
// 先落 assistant 消息，再落合成的失败 tool 消息。
// ============================================================================

import type { Message, ToolCall, ToolResult } from '../../../shared/contract';
import type { ModelResponse } from '../loopTypes';
import { sanitizeToolCallsForHistory } from '../messageHandling/converter';
import type { ContextAssembly } from './contextAssembly';
import type { RuntimeContext } from './runtimeContext';
import { attachTurnQualityMetadata } from './turnQuality';

const BOUNCE_REASONS = {
  goal: '本批工具调用未执行：完成验证未通过，具体原因见随后的系统提示，请先按提示修复。',
  denied: '本批工具调用未执行：其中有工具在本次运行中被禁用，具体原因见随后的系统提示，请改用其他可用方式。',
  repair: '本批工具调用未执行：目标产物已通过重新验证，修复模式已解除，请按需重新发起所需操作。',
} as const;

export async function sealBouncedToolCalls(
  deps: { ctx: RuntimeContext; contextAssembly: ContextAssembly },
  response: ModelResponse,
  toolCalls: ToolCall[],
  kind: keyof typeof BOUNCE_REASONS,
  /** denied 类：被禁用的调用 id；其余调用标为「同批跳过」，与 trace 里 TOOL_DISABLED_FOR_RUN / TOOL_BATCH_SKIPPED 对齐。 */
  deniedCallIds?: Set<string>,
): Promise<'continue'> {
  const reason = BOUNCE_REASONS[kind];
  const { ctx, contextAssembly } = deps;
  if (toolCalls.length === 0) return 'continue';
  const assistantMessage: Message = {
    id: contextAssembly.generateId(),
    role: 'assistant',
    content: response.content || '',
    timestamp: Date.now(),
    toolCalls: sanitizeToolCallsForHistory(toolCalls),
    thinking: response.thinking,
    effortLevel: ctx.turn.effortLevel,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    metadata: attachTurnQualityMetadata(ctx, undefined, response),
  };
  await contextAssembly.addAndPersistMessage(assistantMessage);
  ctx.onEvent({ type: 'message', data: assistantMessage });

  const results: ToolResult[] = toolCalls.map((toolCall) => ({
    toolCallId: toolCall.id,
    success: false,
    error: deniedCallIds && !deniedCallIds.has(toolCall.id)
      ? '本批工具调用未执行：同批中有工具被禁用，整批已跳过。'
      : reason,
    duration: 0,
    metadata: { skipped: true, bounced: true, ...(deniedCallIds ? { code: deniedCallIds.has(toolCall.id) ? 'TOOL_DISABLED_FOR_RUN' : 'TOOL_BATCH_SKIPPED' } : {}) },
  }));
  const toolMessage: Message = {
    id: contextAssembly.generateId(),
    role: 'tool',
    content: JSON.stringify(results),
    timestamp: Date.now(),
    toolResults: results,
  };
  await contextAssembly.addAndPersistMessage(toolMessage);
  ctx.onEvent({ type: 'message', data: toolMessage });
  return 'continue';
}
