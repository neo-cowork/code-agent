import type { EnvAssistNotice } from '../../../shared/contract/envAssist';

// Serialize publishes and resolutions for the same permission across runs.
const pending = new Map<string, Promise<void>>();

/** Writes for one (session, class, target) run one after another: a progress tick never races a resolve. */
export async function queueNoticeWrite(notice: EnvAssistNotice, write: () => Promise<void>): Promise<void> {
  const key = JSON.stringify([notice.sessionId, notice.class, notice.target?.id]);
  const previous = pending.get(key);
  const operation = (async () => {
    if (previous) await previous.catch(() => undefined);
    await write();
  })();
  pending.set(key, operation);
  try { await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
}
