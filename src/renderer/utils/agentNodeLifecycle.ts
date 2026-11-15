import type { AgentTreeNode } from '@shared/contract/agentTree';

/** A fresh context without lifecycle markers is live, but cannot undo a known member terminal. */
export function reconcileAgentNodeLifecycle(
  node: AgentTreeNode,
  member?: { status: string },
): AgentTreeNode {
  if (node.status !== 'unknown'
    || node.sources.some((source) => source === 'spawnGuard' || source === 'backgroundRegistry')) return node;
  const status = member?.status;
  switch (status) {
    case 'completed':
    case 'failed':
    case 'cancelled':
      return { ...node, status };
    default:
      return node;
  }
}
