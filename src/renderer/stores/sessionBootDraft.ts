// Cold-boot helpers for unsent composer drafts. A draft is keyed by the session it was typed in,
// so boot must land on that session (or carry the home draft over) or the card never shows.
import {
  COMPOSER_DRAFT_ADOPTED_EVENT,
  composerDraftStorageKey,
  readComposerDraft,
  readComposerDraftEntry,
  removeComposerDraft,
  writeComposerDraftIfAbsent,
} from '../components/features/chat/ChatInput/composerDraftStore';

const LAST_VIEWED_SESSION_KEY = 'neo:last-viewed-session';

/** Remember which chat the user is looking at so a fresh page (new tab, restart) reopens it. */
export function rememberLastViewedSession(sessionId: string | null): void {
  if (!sessionId) return;
  try {
    window.localStorage.setItem(LAST_VIEWED_SESSION_KEY, sessionId);
  } catch {
    // Storage unavailable: boot opens the new-task start page.
  }
}

function readLastViewedSession<T extends { id: string }>(sessions: T[]): T | null {
  try {
    const id = window.localStorage.getItem(LAST_VIEWED_SESSION_KEY);
    return id ? sessions.find((session) => session.id === id) ?? null : null;
  } catch {
    return null;
  }
}

/** First blank new-task session (list order = most recent first) that holds an unsent draft. */
function findBlankSessionWithDraft<T extends { id: string }>(
  sessions: T[],
  isBlank: (session: T) => boolean,
): T | null {
  return sessions.find((session) => (
    isBlank(session) && readComposerDraft(composerDraftStorageKey(session.id, false)) !== null
  )) ?? null;
}

/** Move the sessionless home draft onto a freshly created session so the card shows there. */
function adoptHomeDraft(sessionId: string): void {
  const homeKey = composerDraftStorageKey(null, false);
  const entry = readComposerDraftEntry(homeKey);
  if (entry === null) return;
  if (writeComposerDraftIfAbsent(composerDraftStorageKey(sessionId, false), entry.text, entry.attachments, entry.dropped)) {
    removeComposerDraft(homeKey);
    // The composer may already be mounted on this session and has read its (then empty) draft.
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(COMPOSER_DRAFT_ADOPTED_EVENT));
  }
}

/**
 * Cold-boot and re-sign-in both pick the session to show. A blank new-task session holding an
 * unsent draft wins, then the chat this browser last viewed (a delegation target that was updated
 * after the originating chat must not steal a fresh page). With no browser-local reason to restore
 * anything (nothing remembered, or the remembered chat is gone) the new-task start page opens via
 * createSession (which reuses an untouched blank session) — never the server's most recent chat,
 * or a first-time browser would append its first task to someone else's old conversation. The home
 * draft moves onto a freshly created session.
 */
export async function openInitialSession<T extends { id: string }>(deps: {
  sessions: T[];
  isBlank: (session: T) => boolean;
  switchSession: (id: string) => Promise<unknown>;
  createSession: () => Promise<{ id: string } | null>;
}): Promise<void> {
  const { sessions, isBlank, switchSession, createSession } = deps;
  const restore = findBlankSessionWithDraft(sessions, isBlank) ?? readLastViewedSession(sessions);
  if (restore) {
    await switchSession(restore.id);
    return;
  }
  const created = await createSession();
  if (created) adoptHomeDraft(created.id);
}
