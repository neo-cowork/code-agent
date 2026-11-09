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

function stateForBackground(handle: BackgroundSubagentHandle): DetachedSubagentState {
  if (handle.status === 'running') return 'running';
  return handle.status === 'completed' ? 'done' : 'failed';
}

function stateForSpawnGuard(agent: ManagedAgent): DetachedSubagentState {
  if (isLiveRunningStatus(agent.status)) return 'running';
  return agent.status === 'completed' ? 'done' : 'failed';
}

function summaryFor(result: { output?: string; error?: string } | undefined): string | undefined {
  const summary = result?.output?.trim() || result?.error?.trim();
  return summary ? summary.slice(0, 240) : undefined;
}

function fromBackgroundRegistry(sessionId: string): DetachedSubagentStatus[] {
  return getBackgroundSubagentRegistry()
    .list()
    .filter((handle) => handle.sessionId === sessionId)
    .map((handle) => ({
      id: handle.agentId,
      shortName: shortName(handle.title, handle.agentId),
      state: stateForBackground(handle),
      ...(handle.status !== 'running'
        ? { summary: summaryFor({ output: handle.result?.output, error: handle.error }) }
        : {}),
    }));
}

function fromSpawnGuard(sessionId: string): DetachedSubagentStatus[] {
  return getSpawnGuard()
    .list({ sessionId })
    .map((agent) => ({
      id: agent.id,
      shortName: shortName(agent.completion?.title, agent.task),
      state: stateForSpawnGuard(agent),
      ...(agent.status !== 'running' && agent.status !== 'running-recovered'
        ? { summary: summaryFor({ output: agent.result?.output, error: agent.error }) }
        : {}),
    }));
}

/** Merge the two existing detached-agent registries, preferring the background entry when both track one id. */
export function listDetachedSubagentStatuses(sessionId: string): DetachedSubagentStatus[] {
  const byId = new Map<string, DetachedSubagentStatus>();
  for (const status of [...fromBackgroundRegistry(sessionId), ...fromSpawnGuard(sessionId)]) {
    if (!byId.has(status.id)) byId.set(status.id, status);
  }
  return [...byId.values()];
}
