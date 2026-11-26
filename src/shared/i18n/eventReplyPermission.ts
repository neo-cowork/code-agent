// ============================================================================
// 事件自动化回复审批卡文案（zh/en）
// ============================================================================

export function eventReplyBoundaryReason(locale: 'zh' | 'en', label: string): string {
  return locale === 'en'
    ? `The reply will be sent to the chat that triggered this automation (${label}).`
    : `回复会发送到触发本自动化的聊天会话（${label}）。`;
}

export function eventReplyRequestReason(locale: 'zh' | 'en', label: string): string {
  return locale === 'en'
    ? `Event automation reply: send this message to ${label}.`
    : `事件自动化回复：把这条消息发到 ${label}。`;
}
