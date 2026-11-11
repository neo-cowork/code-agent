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
  listeners: Set<() => void>;
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
  entry.listeners.forEach((listener) => listener());
}

function subscribeSharedTree(sessionId: string | null, listener: () => void): () => void {
  const key = sessionId ?? '';
  let entry = sharedTrees.get(key);
  if (entry) {
    entry.listeners.add(listener);
  } else {
    const created: SharedAgentTree = { sessionId, snapshot: null, listeners: new Set([listener]), interval: 0 };
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
): AgentTreeSnapshotState {
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? subscribeSharedTree(sessionId, listener) : unsubscribed),
    [enabled, sessionId],
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
