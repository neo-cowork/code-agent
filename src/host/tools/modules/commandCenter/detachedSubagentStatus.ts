import {
  getBackgroundSubagentRegistry,
  type BackgroundSubagentHandle,
} from '../../../agent/backgroundSubagentRegistry';
import { getSpawnGuard, isLiveRunningStatus, type ManagedAgent } from '../../../agent/spawnGuard';
import { formatBackgroundSubagentRows } from './backgroundSubagentTaskRows';

/** The Result body of a finished helper, without the internal "Agent [x] completed task: / Task: / Stats:" wrapper. */
function cleanOutput(output: string | undefined): string | undefined {
  if (!output) return output;
  return output.match(/^Agent \[[^\]]*\] completed task:[\s\S]*?\n\nResult:\n([\s\S]*?)(?:\n\nStats:|$)/)?.[1]
    ?? output.replace(/^Agent \[[^\]]*\] completed task:\s*/, '');
}

function guardAsHandle(agent: ManagedAgent): BackgroundSubagentHandle {
  const live = isLiveRunningStatus(agent.status);
  return {
    agentId: agent.id,
    title: agent.completion?.title || agent.task,
    status: live ? 'running' : agent.status === 'completed' ? 'completed' : 'failed',
    startedAt: agent.createdAt,
    ...(agent.completedAt ? { finishedAt: agent.completedAt } : {}),
    ...(agent.result ? { result: agent.result } : {}),
    ...(agent.error ? { error: agent.error } : {}),
  };
}

/**
 * Task-status rows for detached sub-agents, in the same row format as the BackgroundSubagentRegistry rows.
 * A run_in_background helper is tracked in the registry and, under a different id, in SpawnGuard (linked by
 * `backgroundAgentId`): it is listed once, under the registry entry, named after the agent's display name.
 * SpawnGuard-only helpers (spawn_agent with waitForCompletion:false) are listed after the registry ones.
 */
export function listDetachedSubagentRows(sessionId: string, startIndex: number): string[] {
  const guardAgents = getSpawnGuard().list({ sessionId });
  const displayNames = new Map<string, string>();
  const linkedGuardIds = new Set<string>();
  for (const agent of guardAgents) {
    if (!agent.backgroundAgentId) continue;
    linkedGuardIds.add(agent.id);
    if (agent.completion?.title) displayNames.set(agent.backgroundAgentId, agent.completion.title);
  }
  const registryHandles = getBackgroundSubagentRegistry().listBySession(sessionId);
  const registryIds = new Set(registryHandles.map((handle) => handle.agentId));
  const handles = [
    ...registryHandles.map((handle) => ({ ...handle, title: displayNames.get(handle.agentId) ?? handle.title })),
    ...guardAgents
      .filter((agent) => !linkedGuardIds.has(agent.id) && !registryIds.has(agent.id))
      .map(guardAsHandle),
  ].map((handle) => (handle.result?.output
    ? { ...handle, result: { ...handle.result, output: cleanOutput(handle.result.output) ?? '' } }
    : handle));
  return formatBackgroundSubagentRows(handles, startIndex);
}
