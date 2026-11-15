import { getSubagentContextStore } from '../context/subagentContextStore';
import { createLogger } from '../services/infra/logger';
import type { PendingAgentNotification, SpawnGuardScopeFilter, ManagedAgent } from './spawnGuardModel';
import { buildSubagentCompletionRecord } from './subagentCompletionNotification';

export function formatManagedAgentNotification(agent: ManagedAgent): string {
  return buildSubagentCompletionRecord({
      agentId: agent.id,
      title: agent.completion?.title ?? agent.task,
      role: agent.role,
      kind: agent.completion?.kind,
      status: agent.status === 'completed'
        ? 'completed'
        : agent.status === 'cancelled'
          ? 'cancelled'
          : agent.status === 'killed'
            ? 'killed'
            : 'failed',
      output: agent.result?.output,
      error: agent.error,
      startedAt: agent.createdAt,
      finishedAt: agent.completedAt,
      failureCode: agent.result?.failureCode,
      missingTools: agent.result?.missingTools,
      toolsUsed: agent.result?.toolsUsed,
      iterations: agent.result?.iterations,
      cost: agent.result?.cost,
      sessionId: agent.sessionId,
      runId: agent.runId,
      treeId: agent.treeId,
    }).content;
}

export function matchesNotificationScope(
    entry: PendingAgentNotification,
    scope: SpawnGuardScopeFilter,
  ): boolean {
    if (!entry.sessionId) {
      return !scope.runId && entry.treeId === scope.sessionId;
    }
    if (entry.sessionId !== scope.sessionId) return false;
    if (scope.runId && entry.runId !== scope.runId) return false;
    return !scope.treeId || entry.treeId === scope.treeId;
  }


/** Retain actual completion independently of the guard's short-lived execution cache. */
export function persistManagedAgentTerminal(agent: ManagedAgent): void {
  try {
    getSubagentContextStore().markTerminal(agent.sessionId ?? agent.treeId, agent.id,
      agent.status === 'completed' ? 'completed' : agent.status === 'cancelled' ? 'cancelled' : 'failed', agent.completedAt);
  } catch (error) {
    createLogger('SpawnGuard').warn('Failed to persist child context terminal state', error);
  }
}
