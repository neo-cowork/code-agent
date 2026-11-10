// ============================================================================
// declare_deliverables 记账结果交接：运行时门（recordDeclareDeliverables）写入声明后，
// 把确认/拒绝文本按 sessionId+toolCallId 暂存；executor 执行时取走，作为自己的
// 真实结果返回——这样 tool_call_end 事件（聊天工具卡）与落库结果是同一份文本。
// ============================================================================

export interface DeclareDeliverablesOutcome {
  success: boolean;
  /** success 时是确认文本；失败时是拒绝原因。 */
  text: string;
}

const pending = new Map<string, DeclareDeliverablesOutcome>();

const key = (sessionId: string | undefined, toolCallId: string | undefined): string =>
  `${sessionId ?? ''}:${toolCallId ?? ''}`;

export function stashDeclareOutcome(
  sessionId: string | undefined,
  toolCallId: string,
  outcome: DeclareDeliverablesOutcome,
): void {
  pending.set(key(sessionId, toolCallId), outcome);
}

export function takeDeclareOutcome(
  sessionId: string | undefined,
  toolCallId: string | undefined,
): DeclareDeliverablesOutcome | undefined {
  const k = key(sessionId, toolCallId);
  const outcome = pending.get(k);
  pending.delete(k);
  return outcome;
}
