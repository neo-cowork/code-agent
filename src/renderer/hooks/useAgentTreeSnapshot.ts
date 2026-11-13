import { useCallback, useEffect, useState } from 'react';
import type { AgentTreeSnapshot } from '@shared/contract/agentTree';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';

const AGENT_TREE_REFRESH_INTERVAL_MS = 3000;

export interface AgentTreeSnapshotState {
  snapshot: AgentTreeSnapshot | null;
  refresh: () => Promise<void>;
}

export function useAgentTreeSnapshot(
  sessionId: string | null,
  enabled = true,
  onlyWhileLive = false,
): AgentTreeSnapshotState {
  const [snapshot, setSnapshot] = useState<AgentTreeSnapshot | null>(null);

  const loadSnapshot = useCallback(async () => {
    if (!enabled) return;
    try {
      const next = await ipcService.invokeDomain<AgentTreeSnapshot>(
        IPC_DOMAINS.AGENT,
        'getTree',
        sessionId ? { sessionId } : undefined,
      );
      setSnapshot(next);
      return next;
    } catch {
      setSnapshot(null);
    }
  }, [enabled, sessionId]);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      return undefined;
    }

    let disposed = false;
    const load = async () => {
      if (disposed) return;
      const next = await loadSnapshot();
      if (onlyWhileLive && next && !next.nodes.some((node) => ['running', 'running-recovered', 'queued', 'blocked'].includes(node.status))) {
        clearInterval(interval);
      }
    };
    const interval = setInterval(() => {
      void load();
    }, AGENT_TREE_REFRESH_INTERVAL_MS);
    void load();
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [enabled, loadSnapshot, onlyWhileLive]);

  return { snapshot, refresh: async () => { await loadSnapshot(); } };
}
