import { useCallback, useSyncExternalStore } from 'react';
import type { AgentTreeSnapshot } from '@shared/contract/agentTree';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';

const REFRESH_INTERVAL_MS = 3000;
/** 最后一个订阅者走后，计数再保留这么久：卡片重挂载（先卸后装）时首帧直接读到当前值，而不是 0。 */
const EVICT_GRACE_MS = 10_000;
const LIVE_STATUSES = ['running', 'running-recovered', 'queued', 'blocked'];

interface SessionCountEntry {
  count: number;
  anyLive: boolean;
  keepPolling: Set<symbol>;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  evictTimer: ReturnType<typeof setTimeout> | null;
  updatedAt: number;
  disposed: boolean;
}

/** 每个会话一份：同一会话的所有订阅者（失败卡、侧栏、任务头）共用一个轮询与一份计数，且跨卡片重挂载存活。 */
const entries = new Map<string, SessionCountEntry>();

function entryOf(sessionId: string): SessionCountEntry {
  let entry = entries.get(sessionId);
  if (entry?.listeners.size === 0 && !entry.evictTimer && Date.now() - entry.updatedAt > EVICT_GRACE_MS) {
    entries.delete(sessionId);
    entry = undefined;
  }
  if (!entry) {
    entry = { count: 0, anyLive: true, keepPolling: new Set(), listeners: new Set(), timer: null, evictTimer: null, updatedAt: Date.now(), disposed: false };
    entries.set(sessionId, entry);
  }
  return entry;
}

async function refresh(sessionId: string, entry: SessionCountEntry): Promise<void> {
  let count = 0;
  let anyLive = false;
  try {
    const snapshot = await ipcService.invokeDomain<AgentTreeSnapshot>(IPC_DOMAINS.AGENT, 'getTree', { sessionId });
    if (snapshot?.sessionId === sessionId) {
      anyLive = snapshot.nodes.some((node) => LIVE_STATUSES.includes(node.status));
      count = snapshot.nodes.filter((node) => node.background && LIVE_STATUSES.includes(node.status)).length;
    }
  } catch {
    // 读不到树按 0 处理（与旧行为一致）
  }
  if (entry.disposed) return;
  entry.updatedAt = Date.now();
  entry.anyLive = anyLive;
  if (entry.count !== count) {
    entry.count = count;
    entry.listeners.forEach((listener) => listener());
  }
  if (!anyLive && entry.keepPolling.size === 0 && entry.timer) {
    clearInterval(entry.timer);
    entry.timer = null;
  }
}

function subscribeSession(sessionId: string, keepPolling: boolean, listener: () => void): () => void {
  const entry = entryOf(sessionId);
  const token = Symbol('subscriber');
  if (entry.evictTimer) {
    clearTimeout(entry.evictTimer);
    entry.evictTimer = null;
  }
  entry.listeners.add(listener);
  if (keepPolling) entry.keepPolling.add(token);
  if (!entry.timer) {
    entry.timer = setInterval(() => { void refresh(sessionId, entry); }, REFRESH_INTERVAL_MS);
    void refresh(sessionId, entry);
  }
  return () => {
    entry.listeners.delete(listener);
    entry.keepPolling.delete(token);
    if (entry.listeners.size > 0) return;
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
    entry.evictTimer = setTimeout(() => {
      entry.disposed = true;
      if (entries.get(sessionId) === entry) entries.delete(sessionId);
    }, EVICT_GRACE_MS);
  };
}

const noopSubscribe = () => () => {};

/** Keep observing detached children after the primary error; stop polling when they have all ended. */
export function useLiveBackgroundAgentCount(sessionId: string | null | undefined, enabled = true, keepPolling = false): number {
  const active = Boolean(sessionId) && enabled;
  const subscribe = useCallback(
    (listener: () => void) => (active ? subscribeSession(sessionId as string, keepPolling, listener) : noopSubscribe()),
    [active, sessionId, keepPolling],
  );
  const getSnapshot = useCallback(() => (active ? entryOf(sessionId as string).count : 0), [active, sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
