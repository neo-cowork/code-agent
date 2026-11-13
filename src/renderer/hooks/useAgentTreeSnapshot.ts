import { useCallback, useSyncExternalStore } from 'react';
import type { AgentTreeSnapshot } from '@shared/contract/agentTree';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';

const AGENT_TREE_REFRESH_INTERVAL_MS = 3000;

export interface AgentTreeSnapshotState {
  snapshot: AgentTreeSnapshot | null;
  refresh: () => Promise<void>;
}

interface SharedAgentTree {
  sessionId: string | null;
  snapshot: AgentTreeSnapshot | null;
  listeners: Map<() => void, boolean>;
  interval: number;
}

// One poll per session however many rows and panels read it; the entry lives
// only while something is subscribed.
const sharedTrees = new Map<string, SharedAgentTree>();
const unsubscribed = () => {};
const noSnapshot = () => null;

async function loadSharedTree(entry: SharedAgentTree): Promise<void> {
  let next: AgentTreeSnapshot | null;
  try {
    next = await ipcService.invokeDomain<AgentTreeSnapshot>(
      IPC_DOMAINS.AGENT,
      'getTree',
      entry.sessionId ? { sessionId: entry.sessionId } : undefined,
    );
  } catch {
    next = null;
  }
  if (entry.listeners.size === 0) return;
  entry.snapshot = next;
  entry.listeners.forEach((_onlyWhileLive, listener) => listener());
  if (next && !next.nodes.some(node => ['running', 'running-recovered', 'queued', 'blocked'].includes(node.status))
    && [...entry.listeners.values()].every(Boolean)) {
    window.clearInterval(entry.interval);
    entry.interval = 0;
  }
}

function subscribeSharedTree(sessionId: string | null, listener: () => void, onlyWhileLive: boolean): () => void {
  const key = sessionId ?? '';
  let entry = sharedTrees.get(key);
  if (entry) {
    entry.listeners.set(listener, onlyWhileLive);
    if (!entry.interval && !onlyWhileLive) {
      const active = entry;
      entry.interval = window.setInterval(() => { void loadSharedTree(active); }, AGENT_TREE_REFRESH_INTERVAL_MS);
    }
  } else {
    const created: SharedAgentTree = { sessionId, snapshot: null, listeners: new Map([[listener, onlyWhileLive]]), interval: 0 };
    created.interval = window.setInterval(() => {
      void loadSharedTree(created);
    }, AGENT_TREE_REFRESH_INTERVAL_MS);
    sharedTrees.set(key, created);
    void loadSharedTree(created);
    entry = created;
  }
  const subscribedEntry = entry;
  return () => {
    subscribedEntry.listeners.delete(listener);
    if (subscribedEntry.listeners.size > 0) return;
    window.clearInterval(subscribedEntry.interval);
    if (sharedTrees.get(key) === subscribedEntry) sharedTrees.delete(key);
  };
}

export function useAgentTreeSnapshot(
  sessionId: string | null,
  enabled = true,
  onlyWhileLive = false,
): AgentTreeSnapshotState {
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? subscribeSharedTree(sessionId, listener, onlyWhileLive) : unsubscribed),
    [enabled, sessionId, onlyWhileLive],
  );
  const getSnapshot = useCallback(
    () => (enabled ? sharedTrees.get(sessionId ?? '')?.snapshot ?? null : null),
    [enabled, sessionId],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, noSnapshot);

  const refresh = useCallback(async () => {
    const entry = enabled ? sharedTrees.get(sessionId ?? '') : undefined;
    if (entry) await loadSharedTree(entry);
  }, [enabled, sessionId]);

  return { snapshot, refresh };

}
