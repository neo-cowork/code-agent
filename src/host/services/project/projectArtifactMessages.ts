import type { ToolCall, ToolResult } from '../../../shared/contract/tool';

/**
 * 落库把工具结果放在 tool 行的 tool_results 列，assistant 行的 tool_calls 不带 result。
 * 产物聚合只读 toolCall.result，这里按 toolCallId 补上，已有 result 的不覆盖。
 */
export function attachStoredToolResults<T extends { toolCalls?: ToolCall[]; toolResults?: ToolResult[] }>(
  messages: T[],
): T[] {
  const resultsByCallId = new Map<string, ToolResult>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      if (result?.toolCallId) resultsByCallId.set(result.toolCallId, result);
    }
  }
  if (resultsByCallId.size === 0) return messages;
  return messages.map((message) => {
    const toolCalls = message.toolCalls;
    if (!toolCalls?.some((call) => !call.result && resultsByCallId.has(call.id))) return message;
    return {
      ...message,
      toolCalls: toolCalls.map((call) => (
        call.result || !resultsByCallId.has(call.id)
          ? call
          : { ...call, result: resultsByCallId.get(call.id) }
      )),
    };
  });
}
