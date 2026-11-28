// ============================================================================
// Pending Stop Store — 离线点击「停止」后的待补发意图与提示态
// ============================================================================
// 离线期间 POST /api/cancel 发不出去时，把停止意图绑定到当前会话的当前一轮
// （sessionId + 最新非 meta 用户消息 id + 已知的 runId）存入 sessionStorage，
// 扛住重连后的整页刷新；恢复连接后由 usePendingStopReplay 自动补发。
// ============================================================================

import { create } from 'zustand';

const PENDING_STOP_STORAGE_KEY = 'neo.pendingStop.v1';

interface PendingStopIntent {
  sessionId: string;
  userMessageId: string | null;
  runId?: string;
  at: number;
}

type PendingStopPhase = 'pending' | 'failed' | 'already_finished';

interface PendingStopEntry extends PendingStopIntent {
  phase: PendingStopPhase;
  /** 记录该意图时的 eventStreamRevision；刷新后从 sessionStorage 读回时为 null。 */
  recordedAtRevision: number | null;
}

function getSessionStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage;
    }
    if (typeof sessionStorage !== 'undefined') {
      return sessionStorage;
    }
  } catch {
    // 隐私模式或禁用存储时静默降级为纯内存态
  }
  return null;
}

function isValidStoredIntent(value: unknown): value is PendingStopIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === 'string'
    && record.sessionId.length > 0
    && (record.userMessageId === null || typeof record.userMessageId === 'string')
    && (record.runId === undefined || typeof record.runId === 'string')
    && typeof record.at === 'number'
  );
}

function readStoredPendingStops(): Record<string, PendingStopIntent> {
  const storage = getSessionStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(PENDING_STOP_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, PendingStopIntent> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidStoredIntent(value) && value.sessionId === key) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeStoredPendingStops(entries: Record<string, PendingStopEntry>): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const persisted: Record<string, PendingStopIntent> = {};
    for (const [sessionId, entry] of Object.entries(entries)) {
      if (entry.phase !== 'pending') continue;
      persisted[sessionId] = {
        sessionId: entry.sessionId,
        userMessageId: entry.userMessageId,
        ...(entry.runId ? { runId: entry.runId } : {}),
        at: entry.at,
      };
    }
    if (Object.keys(persisted).length === 0) {
      storage.removeItem(PENDING_STOP_STORAGE_KEY);
    } else {
      storage.setItem(PENDING_STOP_STORAGE_KEY, JSON.stringify(persisted));
    }
  } catch {
    // 忽略配额或禁用存储异常
  }
}

function buildInitialEntries(): Record<string, PendingStopEntry> {
  const stored = readStoredPendingStops();
  const entries: Record<string, PendingStopEntry> = {};
  for (const [sessionId, intent] of Object.entries(stored)) {
    entries[sessionId] = {
      ...intent,
      phase: 'pending',
      recordedAtRevision: null,
    };
  }
  return entries;
}

interface PendingStopStoreState {
  entries: Record<string, PendingStopEntry>;
  recordPending: (intent: PendingStopIntent, recordedAtRevision: number) => void;
  markFailed: (intent: PendingStopIntent) => void;
  markAlreadyFinished: (sessionId: string) => void;
  clear: (sessionId: string) => void;
  hydrateFromStorage: () => void;
}

export const usePendingStopStore = create<PendingStopStoreState>()((set) => ({
  entries: buildInitialEntries(),

  recordPending: (intent, recordedAtRevision) => {
    set((state) => {
      const nextEntries: Record<string, PendingStopEntry> = {
        ...state.entries,
        [intent.sessionId]: {
          ...intent,
          phase: 'pending',
          recordedAtRevision,
        },
      };
      writeStoredPendingStops(nextEntries);
      return { entries: nextEntries };
    });
  },

  markFailed: (intent) => {
    set((state) => {
      const nextEntries: Record<string, PendingStopEntry> = {
        ...state.entries,
        [intent.sessionId]: {
          ...intent,
          phase: 'failed',
          recordedAtRevision: null,
        },
      };
      writeStoredPendingStops(nextEntries);
      return { entries: nextEntries };
    });
  },

  markAlreadyFinished: (sessionId) => {
    set((state) => {
      const existing = state.entries[sessionId];
      if (!existing) return state;
      const nextEntries: Record<string, PendingStopEntry> = {
        ...state.entries,
        [sessionId]: {
          ...existing,
          phase: 'already_finished',
          recordedAtRevision: null,
        },
      };
      writeStoredPendingStops(nextEntries);
      return { entries: nextEntries };
    });
  },

  clear: (sessionId) => {
    set((state) => {
      if (!(sessionId in state.entries)) return state;
      const nextEntries = { ...state.entries };
      delete nextEntries[sessionId];
      writeStoredPendingStops(nextEntries);
      return { entries: nextEntries };
    });
  },

  hydrateFromStorage: () => {
    const stored = readStoredPendingStops();
    if (Object.keys(stored).length === 0) return;
    set((state) => {
      let changed = false;
      const nextEntries = { ...state.entries };
      for (const [sessionId, intent] of Object.entries(stored)) {
        if (!nextEntries[sessionId]) {
          nextEntries[sessionId] = {
            ...intent,
            phase: 'pending',
            recordedAtRevision: null,
          };
          changed = true;
        }
      }
      return changed ? { entries: nextEntries } : state;
    });
  },
}));
