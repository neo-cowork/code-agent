// ============================================================================
// offlinePendingSendStore — Surface A 离线待发送记录（sessionStorage）
// ============================================================================
// 按 composerKey 持久化 { composerKey, text, clientMessageId, at }，
// 跨 serverConnectionMonitor 恢复刷新保留，但关闭标签页即自然失效。
// ============================================================================

const STORAGE_KEY_PREFIX = 'neo.offlinePendingSend.v1:';

export interface OfflinePendingSendRecord {
  composerKey: string;
  text: string;
  clientMessageId: string;
  at: number;
}

function storageKey(composerKey: string): string {
  return `${STORAGE_KEY_PREFIX}${composerKey}`;
}

function getSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readOfflinePendingSend(composerKey: string | null): OfflinePendingSendRecord | null {
  if (!composerKey) return null;
  const store = getSessionStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(storageKey(composerKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OfflinePendingSendRecord>;
    if (
      parsed.composerKey !== composerKey
      || typeof parsed.text !== 'string'
      || !parsed.text.trim()
      || typeof parsed.clientMessageId !== 'string'
      || !parsed.clientMessageId.trim()
      || typeof parsed.at !== 'number'
    ) {
      return null;
    }
    return {
      composerKey: parsed.composerKey,
      text: parsed.text,
      clientMessageId: parsed.clientMessageId,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}

export function writeOfflinePendingSend(record: OfflinePendingSendRecord): void {
  const store = getSessionStorage();
  if (!store) return;
  try {
    store.setItem(storageKey(record.composerKey), JSON.stringify(record));
  } catch {
    // Private mode / quota exceeded: degrade silently, text stays in box.
  }
}

export function clearOfflinePendingSend(composerKey: string | null): void {
  if (!composerKey) return;
  const store = getSessionStorage();
  if (!store) return;
  try {
    store.removeItem(storageKey(composerKey));
  } catch {
    // Ignore storage errors on clear.
  }
}

// 同页记录离线失败当刻的 eventStreamRevision（刷新后新堆为空，允许挂载即重放）。
const composerFailureRevisions = new Map<string, number>();

export function noteComposerOfflineFailureRevision(composerKey: string, revision: number): void {
  composerFailureRevisions.set(composerKey, revision);
}

export function getComposerOfflineFailureRevision(composerKey: string): number | undefined {
  return composerFailureRevisions.get(composerKey);
}

export function clearComposerOfflineFailureRevision(composerKey: string): void {
  composerFailureRevisions.delete(composerKey);
}
