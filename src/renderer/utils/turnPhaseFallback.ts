// ============================================================================
// TurnPhaseFallback - 轮头阶段兜底标签（N-FIX-SIGNED-OUT-SEND-500-RAW-HTML-REDESIGN）
// ============================================================================
// TurnCard.getTurnPhase 的最后一段：无工具、非流式时按「有无助手正文」给
// 「回复已生成 / 等待输出」。两处修正搬到这里：
//   ① 发送失败的轮（用户气泡带 sendFailed）不许再标「回复已生成」——失败句
//     旁边挂着“已生成”是自相矛盾；
//   ② 文案从 t.turnRun 取（zh/en），不再硬编码中文。
// ============================================================================

import type { TraceTurn } from '@shared/contract/trace';
import type { Translations } from '../i18n';

export function turnPhaseFallbackLabel(turn: TraceTurn, t: Translations): string | null {
  if (turn.status === 'error' || turn.nodes.some((node) => (
    (node.type === 'user' && node.metadata?.sendFailed === true)
    || node.turnTimeline?.tone === 'error'
  ))) {
    return null;
  }
  const assistantText = [...turn.nodes]
    .reverse()
    .find((node) => node.type === 'assistant_text' && node.content.trim());
  return assistantText ? t.turnRun.replyGenerated : t.turnRun.awaitingOutput;
}
