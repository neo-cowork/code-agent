// ============================================================================
// projectTrustTurn - 发送被拒轮（未进 host 运行期）的统一判据
// ============================================================================
// 所有未进 host 运行期的发送失败（sendFailureCode 非空）气泡已给明确下一步，
// 轮头「遇到问题」徽章与红色「等待恢复」横幅统一让位（isSendFailureTurn）。
// 其中 PROJECT_SOURCE_TRUST 自带「确认并重发」按钮，额外收起用户气泡「没发出去 · 编辑重发」
// 徽章（isProjectTrustPendingTurn）；其余发送失败保留该徽章作重试入口。
// ============================================================================

import type { TraceTurn } from '@shared/contract/trace';

const PROJECT_SOURCE_TRUST_FAILURE_CODE = 'PROJECT_SOURCE_TRUST';

export function isSendFailureTurn(turn: Pick<TraceTurn, 'nodes'>): boolean {
  const hasMarker = turn.nodes.some((node) => Boolean(node.metadata?.sendFailureCode));
  if (!hasMarker) return false;
  const userNodes = turn.nodes.filter((node) => node.type === 'user');
  return userNodes.length === 0 || userNodes.some((node) => node.metadata?.sendFailed === true);
}

export function isProjectTrustPendingTurn(turn: Pick<TraceTurn, 'nodes'>): boolean {
  return turn.nodes.some((node) => node.metadata?.sendFailureCode === PROJECT_SOURCE_TRUST_FAILURE_CODE)
    && isSendFailureTurn(turn);
}
