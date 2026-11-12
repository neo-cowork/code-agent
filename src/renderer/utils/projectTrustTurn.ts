// ============================================================================
// projectTrustTurn - 「旧项目需确认」发送失败轮的统一判据
// ============================================================================
// PROJECT_SOURCE_TRUST 不是故障，是一次待确认：轮内只留一句人话 + 「确认并重发」。
// 通用失败装饰（用户气泡「没发出去 · 编辑重发」、轮头「遇到问题」徽章、红色 blocked
// 横幅）都以这个判据为准让位。
// ============================================================================

import type { TraceTurn } from '@shared/contract/trace';

const PROJECT_SOURCE_TRUST_FAILURE_CODE = 'PROJECT_SOURCE_TRUST';

export function isProjectTrustPendingTurn(turn: Pick<TraceTurn, 'nodes'>): boolean {
  return turn.nodes.some((node) => node.metadata?.sendFailureCode === PROJECT_SOURCE_TRUST_FAILURE_CODE);
}
