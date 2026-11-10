import { useAgentTreeSnapshot } from './useAgentTreeSnapshot';

/** Keep observing detached children after the primary error; stop polling when they have all ended. */
export function useLiveBackgroundAgentCount(sessionId: string | null | undefined, enabled = true, keepPolling = false): number {
  const { snapshot } = useAgentTreeSnapshot(sessionId ?? null, Boolean(sessionId) && enabled, !keepPolling);
  if (!enabled || !snapshot || snapshot.sessionId !== sessionId) return 0;
  return snapshot.nodes.filter((node) => node.background
    && ['running', 'running-recovered', 'queued', 'blocked'].includes(node.status)).length;
}
