import { NEEDS_INPUT_NATIVE_FALLBACK } from '../../../shared/constants/timeouts';
import { getNeedsInputNativeFallbackText } from '../../../shared/i18n/needsInputNativeFallback';
import { toolUserLabel } from '../../../shared/utils/toolUserLabel';
import { sanitizeNotificationText } from './notificationPolicy';

type NativePayload = { id: string; sessionId: string; title: string; body: string };
type Pending = {
  id: string;
  keyed: Map<string, string | undefined>;
  keylessCount: number;
  keylessTool?: string;
  foldTimer?: ReturnType<typeof setTimeout>;
  quietTimer?: ReturnType<typeof setTimeout>;
};

/** One burst banner per session; unresolved keyless items expire only after quiet. */
export class NeedsInputNativeFallback {
  private readonly sessions = new Map<string, Pending>();

  constructor(private readonly deps: {
    locale: () => 'zh' | 'en';
    sessionTitle: (sessionId: string) => Promise<string | undefined>;
    deliver: (payload: NativePayload) => void;
    folded: (sessionId: string) => void;
    canDeliver: () => boolean;
    failed: () => void;
  }) {}

  enqueue(data: { id: string; sessionId: string; dedupeKey?: string; tool?: string }): void {
    let pending = this.sessions.get(data.sessionId);
    const folded = !!pending;
    if (!pending) {
      pending = { id: data.id, keyed: new Map(), keylessCount: 0 };
      this.sessions.set(data.sessionId, pending);
      const batch = pending;
      batch.foldTimer = setTimeout(() => { void this.flush(data.sessionId, batch); }, NEEDS_INPUT_NATIVE_FALLBACK.FOLD_WINDOW_MS);
      batch.foldTimer.unref();
    }
    if (data.dedupeKey) pending.keyed.set(data.dedupeKey, data.tool);
    else {
      if (!pending.keylessCount) pending.keylessTool = data.tool;
      pending.keylessCount++;
    }
    clearTimeout(pending.quietTimer);
    pending.quietTimer = setTimeout(() => this.remove(data.sessionId), NEEDS_INPUT_NATIVE_FALLBACK.QUIET_PERIOD_MS);
    pending.quietTimer.unref();
    if (folded) this.deps.folded(data.sessionId);
  }

  retract(key: string): void {
    for (const [sessionId, pending] of this.sessions) {
      if (pending.keyed.delete(key) && !pending.keyed.size && !pending.keylessCount) this.remove(sessionId);
    }
  }

  clear(): void {
    for (const sessionId of this.sessions.keys()) this.remove(sessionId);
  }

  private remove(sessionId: string): void {
    const pending = this.sessions.get(sessionId);
    clearTimeout(pending?.foldTimer);
    clearTimeout(pending?.quietTimer);
    this.sessions.delete(sessionId);
  }

  private async flush(sessionId: string, pending: Pending): Promise<void> {
    let title: string | undefined;
    try { title = await this.deps.sessionTitle(sessionId); } catch { /* Use localized untitled copy. */ }
    // A resolution/clear while the title was loading must cancel the stale banner too.
    if (this.sessions.get(sessionId) !== pending || !this.deps.canDeliver()) return;
    const locale = this.deps.locale();
    const text = getNeedsInputNativeFallbackText(locale);
    const count = pending.keyed.size + pending.keylessCount;
    const tool = pending.keylessCount ? pending.keylessTool : pending.keyed.values().next().value;
    try {
      this.deps.deliver({
        id: pending.id,
        sessionId,
        title: sanitizeNotificationText(title, 120, { omitIds: true }).trim() || text.untitledSession,
        body: count === 1 ? text.single(toolUserLabel(tool, locale)) : text.multiple(count),
      });
    } catch { this.deps.failed(); }
  }
}
