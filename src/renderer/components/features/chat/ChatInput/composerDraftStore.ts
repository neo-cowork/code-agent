// Per-session idle composer draft (text + inline attachments within budget).
// Voice and @refs are not stored. localStorage only — queued_inputs is for messages handed to host.

import { COMPOSER_DRAFT_ATTACHMENT_BUDGET_BYTES, UI } from '@shared/constants';
import type { MessageAttachment } from '@shared/contract';

export const COMPOSER_DRAFT_DEBOUNCE_MS = 400;
const COMPOSER_DRAFT_PREVIEW_LIMIT = 40;
export const COMPOSER_DRAFT_SEND_TIMEOUT_MS = 15_000;
const COMPOSER_DRAFT_KEY_PREFIX = 'neo.composerDraft.v1:';
const COMPOSER_DRAFT_HOME_KEY = `${COMPOSER_DRAFT_KEY_PREFIX}home`;

/** Fired after a draft is written from outside the composer (boot adopting the home draft). */
export const COMPOSER_DRAFT_ADOPTED_EVENT = 'neo:composer-draft-adopted';

export type ComposerDraftSendOutcome = 'success' | 'failure' | 'timeout';

interface ComposerDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredComposerDraftV1 {
  v: 1;
  text: string;
}

interface StoredComposerDraftV2 {
  v: 2;
  text: string;
  attachments?: MessageAttachment[];
  dropped?: string[];
}

export interface ComposerDraftEntry {
  text: string;
  attachments: MessageAttachment[];
  dropped: string[];
}

interface ComposerDraftFlushTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface ComposerDraftVisibilityTarget extends ComposerDraftFlushTarget {
  visibilityState: string;
}

interface PendingDraftWrite {
  key: string | null;
  text: string;
  attachments: readonly MessageAttachment[];
  isSendInFlight: () => boolean;
}

export interface ComposerDraftWriter {
  schedule(
    key: string | null,
    text: string,
    isSendInFlight: () => boolean,
    attachments?: readonly MessageAttachment[],
  ): void;
  /** Drop the timer and write this draft now. Empty draft does not delete while a send is in flight. */
  flushNow(
    key: string | null,
    text: string,
    isSendInFlight: () => boolean,
    attachments?: readonly MessageAttachment[],
  ): void;
  /** Write whatever schedule() last queued. Used on page hide and before a session switch. */
  flushPending(): void;
  cancel(): void;
  dispose(): void;
}

const utf8Encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function sanitizeAttachmentDisplayName(name: string): string {
  const trimmed = name.trim();
  const base = trimmed.split(/[\\/]/).pop()?.trim();
  return base || trimmed || 'attachment';
}

function isValidDraftAttachment(value: unknown): value is MessageAttachment {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MessageAttachment>;
  return (
    typeof candidate.id === 'string'
    && candidate.id.length > 0
    && (candidate.type === 'image' || candidate.type === 'file')
    && typeof candidate.category === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.size === 'number'
    && typeof candidate.mimeType === 'string'
  );
}

export function composerDraftStorageKey(
  sessionId: string | null,
  sessionless: boolean,
  scopeProjectId: string | null = null,
): string | null {
  // 项目页 composer（sessionless + 项目 id）按项目存草稿；其他 sessionless 场景仍不落盘
  if (sessionless) return scopeProjectId ? `${COMPOSER_DRAFT_KEY_PREFIX}space:${scopeProjectId}` : null;
  if (sessionId === null) return COMPOSER_DRAFT_HOME_KEY;
  return `${COMPOSER_DRAFT_KEY_PREFIX}${sessionId}`;
}

export function composerDraftPreview(text: string, limit = COMPOSER_DRAFT_PREVIEW_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function hasDraftText(text: string): boolean {
  return text.trim().length > 0;
}

export function hasComposerDraftContent(
  text: string,
  attachments: readonly MessageAttachment[] = [],
): boolean {
  return hasDraftText(text) || attachments.length > 0;
}

export function readComposerDraftEntry(
  key: string | null,
  storage?: Pick<ComposerDraftStorage, 'getItem'>,
): ComposerDraftEntry | null {
  if (!key) return null;
  // Boot code also runs where localStorage does not exist (node tests, SSR): no storage = no draft.
  const source = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (!source) return null;
  try {
    const raw = source.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredComposerDraftV1 | StoredComposerDraftV2>;
    if (parsed.v === 1) {
      if (typeof parsed.text !== 'string' || !hasDraftText(parsed.text)) return null;
      return { text: parsed.text, attachments: [], dropped: [] };
    }
    if (parsed.v === 2) {
      if (typeof parsed.text !== 'string') return null;
      const validAttachments = Array.isArray(parsed.attachments)
        ? parsed.attachments.filter(isValidDraftAttachment)
        : [];
      const attachments = validAttachments.slice(0, UI.MAX_ATTACHMENTS_DROP);
      const overflowNames = validAttachments
        .slice(UI.MAX_ATTACHMENTS_DROP)
        .map((att) => sanitizeAttachmentDisplayName(att.name));
      const parsedDropped = Array.isArray(parsed.dropped)
        ? parsed.dropped
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map(sanitizeAttachmentDisplayName)
        : [];
      const dropped = [...parsedDropped, ...overflowNames];
      if (!hasDraftText(parsed.text) && attachments.length === 0 && dropped.length === 0) {
        return null;
      }
      return { text: parsed.text, attachments, dropped };
    }
    return null;
  } catch {
    return null;
  }
}

export function readComposerDraft(
  key: string | null,
  storage?: Pick<ComposerDraftStorage, 'getItem'>,
): string | null {
  const entry = readComposerDraftEntry(key, storage);
  return entry ? entry.text : null;
}

function buildStoredDraftV2(
  text: string,
  attachments: MessageAttachment[],
  dropped: string[],
): StoredComposerDraftV2 {
  const payload: StoredComposerDraftV2 = { v: 2, text };
  if (attachments.length > 0) payload.attachments = attachments;
  if (dropped.length > 0) payload.dropped = dropped;
  return payload;
}

/** Empty draft (no text, no attachments, no carried-over dropped names) is ignored. */
function writeComposerDraft(
  key: string | null,
  text: string,
  attachments: readonly MessageAttachment[] = [],
  storage: ComposerDraftStorage = localStorage,
  extraDropped: readonly string[] = [],
): ComposerDraftEntry | null {
  const cleanedExtra = extraDropped
    .filter((name) => name.trim().length > 0)
    .map(sanitizeAttachmentDisplayName);
  if (!key || (!hasDraftText(text) && attachments.length === 0 && cleanedExtra.length === 0)) {
    return null;
  }

  const kept: MessageAttachment[] = [];
  const dropped: string[] = [...cleanedExtra];
  let usedBytes = utf8ByteLength(JSON.stringify({ v: 2, text }));

  for (const att of attachments) {
    if (kept.length >= UI.MAX_ATTACHMENTS_DROP) {
      dropped.push(sanitizeAttachmentDisplayName(att.name));
      continue;
    }
    const attBytes = utf8ByteLength(JSON.stringify(att)) + 1;
    if (usedBytes + attBytes <= COMPOSER_DRAFT_ATTACHMENT_BUDGET_BYTES) {
      kept.push(att);
      usedBytes += attBytes;
    } else {
      dropped.push(sanitizeAttachmentDisplayName(att.name));
    }
  }

  try {
    storage.setItem(key, JSON.stringify(buildStoredDraftV2(text, kept, dropped)));
    return { text, attachments: kept, dropped };
  } catch {
    if (kept.length === 0) return null;
    const allDropped = [
      ...cleanedExtra,
      ...attachments.map((att) => sanitizeAttachmentDisplayName(att.name)),
    ];
    try {
      storage.setItem(key, JSON.stringify(buildStoredDraftV2(text, [], allDropped)));
      return { text, attachments: [], dropped: allDropped };
    } catch {
      return null;
    }
  }
}

/** Write only when the key holds no draft yet. Returns true when the key ends up holding this draft. */
export function writeComposerDraftIfAbsent(
  key: string | null,
  text: string,
  attachments: readonly MessageAttachment[] = [],
  dropped: readonly string[] = [],
): boolean {
  if (readComposerDraftEntry(key) !== null) return false;
  return writeComposerDraft(key, text, attachments, localStorage, dropped) !== null;
}

export function removeComposerDraft(
  key: string | null,
  storage: Pick<ComposerDraftStorage, 'removeItem'> = localStorage,
): void {
  if (!key) return;
  try {
    storage.removeItem(key);
  } catch {
    // Private mode and quota failures leave the in-memory composer as the source of truth.
  }
}

function defaultPageTarget(): ComposerDraftFlushTarget | null {
  return typeof window === 'undefined' ? null : window;
}

function defaultVisibilityTarget(): ComposerDraftVisibilityTarget | null {
  return typeof document === 'undefined' ? null : document;
}

export function createComposerDraftWriter(options: {
  storage?: ComposerDraftStorage;
  delayMs?: number;
  pageTarget?: ComposerDraftFlushTarget | null;
  visibilityTarget?: ComposerDraftVisibilityTarget | null;
  onCommitted?: (key: string, entry: ComposerDraftEntry) => void;
  onRemoved?: (key: string) => void;
} = {}): ComposerDraftWriter {
  const storage = options.storage ?? localStorage;
  const delayMs = options.delayMs ?? COMPOSER_DRAFT_DEBOUNCE_MS;
  const pageTarget = options.pageTarget === undefined ? defaultPageTarget() : options.pageTarget;
  const visibilityTarget = options.visibilityTarget === undefined ? defaultVisibilityTarget() : options.visibilityTarget;
  let pending: PendingDraftWrite | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const commit = (entry: PendingDraftWrite): void => {
    if (!entry.key) return;
    if (!hasComposerDraftContent(entry.text, entry.attachments)) {
      // Optimistic clear empties the box before anyone knows whether the send landed.
      // Deleting here would drop the only copy. A later success outcome removes it.
      if (entry.isSendInFlight()) return;
      removeComposerDraft(entry.key, storage);
      options.onRemoved?.(entry.key);
      return;
    }
    const committed = writeComposerDraft(entry.key, entry.text, entry.attachments, storage);
    if (committed) {
      options.onCommitted?.(entry.key, committed);
    }
  };

  const cancelTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const flushPending = (): void => {
    const entry = pending;
    pending = null;
    cancelTimer();
    if (entry) commit(entry);
  };

  const onPageHide = (): void => {
    flushPending();
  };

  const onVisibility = (): void => {
    if (visibilityTarget?.visibilityState === 'hidden') flushPending();
  };

  pageTarget?.addEventListener('pagehide', onPageHide);
  visibilityTarget?.addEventListener('visibilitychange', onVisibility);

  return {
    schedule(key, text, isSendInFlight, attachments = []) {
      pending = { key, text, attachments, isSendInFlight };
      cancelTimer();
      timer = setTimeout(() => {
        timer = null;
        const entry = pending;
        pending = null;
        if (entry) commit(entry);
      }, delayMs);
    },
    flushNow(key, text, isSendInFlight, attachments = []) {
      pending = null;
      cancelTimer();
      commit({ key, text, attachments, isSendInFlight });
    },
    flushPending,
    cancel() {
      pending = null;
      cancelTimer();
    },
    dispose() {
      pending = null;
      cancelTimer();
      pageTarget?.removeEventListener('pagehide', onPageHide);
      visibilityTarget?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
