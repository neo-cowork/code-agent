// ============================================================================
// 前台轮次丢弃 Bash 调用时的用户可见终态文案（zh/en）
// ============================================================================

import { INABILITY_REPLY_CONTRACT } from '../inabilityReplyContract';

export function formatForegroundShellDenialFinalMessage(locale: 'zh' | 'en'): string {
  return INABILITY_REPLY_CONTRACT[locale].finalMessage;
}
