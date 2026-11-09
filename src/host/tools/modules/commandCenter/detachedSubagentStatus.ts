import {
  getBackgroundSubagentRegistry,
  type BackgroundSubagentHandle,
} from '../../../agent/backgroundSubagentRegistry';
import {
  getSpawnGuard,
  isLiveRunningStatus,
  type ManagedAgent,
} from '../../../agent/spawnGuard';

export type DetachedSubagentState = 'running' | 'done' | 'failed';

export interface DetachedSubagentStatus {
  id: string;
  shortName: string;
  state: DetachedSubagentState;
  summary?: string;
}

function shortName(value: string | undefined, fallback: string): string {
  const compact = (value ?? '').replace(/\s+/g, '').trim();
  const chars = Array.from(compact);
  if (chars.length >= 2 && chars.length <= 4) return compact;
  if (chars.length > 4) {
    const words = compact.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g);
    if (words && words.length >= 2) {
      const initials = words.map((word) => Array.from(word)[0]).join('').toUpperCase();
      if (Array.from(initials).length >= 2 && Array.from(initials).length <= 4) return initials;
    }
    return chars.slice(0, 4).join('');
  }
  const fallbackChars = Array.from(fallback.replace(/\s+/g, '').trim());
  return fallbackChars.slice(0, 4).join('') || '任务';
}

function displayName(name: string | undefined, fallback: string | undefined, fallbackId: string): string {
  const trimmed = name?.trim();
  return trimmed ? Array.from(trimmed).slice(0, 16).join('') : shortName(fallback, fallbackId);
}

/** spawn 的 name 会被登记成后台条目的 title；一小段不含空白的文字当名字用，长任务描述仍走缩写。 */
function nameLikeTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  return trimmed && !/\s/.test(trimmed) && Array.from(trimmed).length <= 16 ? trimmed : undefined;
}

function stateForBackground(handle: BackgroundSubagentHandle): DetachedSubagentState {
  if (handle.status === 'running') return 'running';
  return handle.status === 'completed' ? 'done' : 'failed';
}

function stateForSpawnGuard(agent: ManagedAgent): DetachedSubagentState {
  if (isLiveRunningStatus(agent.status)) return 'running';
  return agent.status === 'completed' ? 'done' : 'failed';
}

function summaryFor(result: { output?: string; error?: string } | undefined): string | undefined {
  const output = result?.output;
  const body = output?.match(/^Agent \[[^\]]*\] completed task:[\s\S]*?\n\nResult:\n([\s\S]*?)(?:\n\nStats:|$)/)?.[1]
    ?? output?.replace(/^Agent \[[^\]]*\] completed task:\s*/, '');
  const summary = body?.trim() || result?.error?.trim();
  return summary ? summary.slice(0, 240) : undefined;
}

function fromBackgroundRegistry(sessionId: string, displayNames: Map<string, string>): DetachedSubagentStatus[] {
  return getBackgroundSubagentRegistry()
    .list()
    .filter((handle) => handle.sessionId === sessionId)
    .map((handle) => ({
      id: handle.agentId,
      shortName: displayName(displayNames.get(handle.agentId) ?? nameLikeTitle(handle.title), handle.title, handle.agentId),
      state: stateForBackground(handle),
      ...(handle.status !== 'running'
        ? { summary: summaryFor({ output: handle.result?.output, error: handle.error }) }
        : {}),
    }));
}

function fromSpawnGuard(agents: ManagedAgent[]): DetachedSubagentStatus[] {
  return agents.map((agent) => ({
    id: agent.id,
    shortName: displayName(agent.completion?.title, agent.task, agent.id),
    state: stateForSpawnGuard(agent),
    ...(agent.status !== 'running' && agent.status !== 'running-recovered'
      ? { summary: summaryFor({ output: agent.result?.output, error: agent.error }) }
      : {}),
  }));
}

/**
 * Merge the two existing detached-agent registries. A run_in_background helper is tracked in both
 * (registry id + an inner SpawnGuard id linked by `backgroundAgentId`); list it once, under the
 * registry entry, named after the agent's display name.
 */
export function listDetachedSubagentStatuses(sessionId: string): DetachedSubagentStatus[] {
  const guardAgents = getSpawnGuard().list({ sessionId });
  const displayNames = new Map<string, string>();
  const linkedGuardIds = new Set<string>();
  for (const agent of guardAgents) {
    if (!agent.backgroundAgentId) continue;
    linkedGuardIds.add(agent.id);
    if (agent.completion?.title) displayNames.set(agent.backgroundAgentId, agent.completion.title);
  }
  const byId = new Map<string, DetachedSubagentStatus>();
  const unlinkedGuard = guardAgents.filter((agent) => !linkedGuardIds.has(agent.id));
  for (const status of [...fromBackgroundRegistry(sessionId, displayNames), ...fromSpawnGuard(unlinkedGuard)]) {
    if (!byId.has(status.id)) byId.set(status.id, status);
  }
  return [...byId.values()];
}
