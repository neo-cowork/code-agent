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
import { UNSORTED_PROJECT_ID } from '@shared/contract/project';

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

/**
 * First untouched blank new-task session in the server list: no folder, not owned by a space.
 * Picked from the list boot already holds because createSession reads the live store list, which
 * the auth-change reload may have just emptied — it would then create a duplicate blank session.
 */
function findUntouchedBlankSession<T extends { id: string }>(
  sessions: T[],
  isBlank: (session: T) => boolean,
): T | null {
  return sessions.find((session) => {
    const { workingDirectory, projectId } = session as T & { workingDirectory?: string | null; projectId?: string | null };
    const owner = projectId?.trim() ?? '';
    return isBlank(session) && !workingDirectory?.trim() && (owner === '' || owner === UNSORTED_PROJECT_ID);
  }) ?? null;
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
 * anything (nothing remembered, or the remembered chat is gone) the new-task start page opens: an
 * untouched blank session from the list is reused (createSession would read the live store list,
 * which an auth-change reload may have just emptied, and pile up a duplicate), else createSession
 * — never the server's most recent chat,
 * or a first-time browser would append its first task to someone else's old conversation. The home
 * draft moves onto the blank session that opens.
 * The pick happens in the background: callers pass switch/create that keep any secondary page
 * (Automation, plugins…) the user opened while boot was still waiting for the session list.
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
  const reusable = findUntouchedBlankSession(sessions, isBlank);
  if (reusable) {
    await switchSession(reusable.id);
    adoptHomeDraft(reusable.id);
    return;
  }
  const created = await createSession();
  if (created) adoptHomeDraft(created.id);
}
