import { useCallback, useEffect, useRef, useState } from 'react';
import { UI } from '@shared/constants';
import type { MessageAttachment } from '@shared/contract';
import { mergeAttachments } from './attachmentDedupe';
import {
  COMPOSER_DRAFT_ADOPTED_EVENT,
  COMPOSER_DRAFT_DEBOUNCE_MS,
  COMPOSER_DRAFT_SEND_TIMEOUT_MS,
  composerDraftPreview,
  composerDraftStorageKey,
  createComposerDraftWriter,
  hasComposerDraftContent,
  readComposerDraftEntry,
  removeComposerDraft,
  type ComposerDraftEntry,
  type ComposerDraftSendOutcome,
  type ComposerDraftWriter,
} from './composerDraftStore';

const EMPTY_ATTACHMENTS: MessageAttachment[] = [];

interface ComposerDraftNotice {
  text: string;
  preview: string;
  attachmentNames: string[];
  droppedNames: string[];
}

interface ComposerDraftPersistence {
  notice: ComposerDraftNotice | null;
  putBack: () => void;
  discard: () => void;
  /**
   * Call immediately before the optimistic setValue('') / setAttachments([]).
   * Flushes the current draft and marks the send in flight so the empty box
   * does not delete the stored draft.
   */
  noteOptimisticClear: () => void;
  /** Delete the stored draft only for 'success'. Failure and timeout keep it. */
  noteSendSettled: (outcome: ComposerDraftSendOutcome) => void;
  /**
   * Public send wrapper: optimistic-clear hold, then delete only when `send`
   * resolves true. false, a throw, and a timeout all leave the stored draft.
   */
  trackSend: (send: () => boolean | Promise<boolean>) => Promise<boolean | 'timeout'>;
}

export function useComposerDraftPersistence(args: {
  sessionId: string | null;
  sessionless: boolean;
  /** 项目页 composer 的项目 id：sessionless 时据此按项目落草稿。 */
  scopeProjectId?: string | null;
  value: string;
  setValue: (value: string) => void;
  attachments?: MessageAttachment[];
  setAttachments?: (attachments: MessageAttachment[]) => void;
  /** Queued-edit mode borrows the box. Don't persist that text or clear the idle draft when it leaves. */
  suspend?: boolean;
}): ComposerDraftPersistence {
  const {
    sessionId,
    sessionless,
    scopeProjectId = null,
    value,
    setValue,
    attachments = EMPTY_ATTACHMENTS,
    setAttachments,
    suspend = false,
  } = args;
  const key = composerDraftStorageKey(sessionId, sessionless, scopeProjectId);
  const keyRef = useRef(key);
  const prevKeyRef = useRef(key);
  const valueRef = useRef(value);
  valueRef.current = value;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const sendInFlightRef = useRef(false);
  // Key of the session that started the send. The settle can land after a
  // session switch, so it must not read whatever key is current by then.
  const sendKeyRef = useRef<string | null>(null);
  const ignoreNextEmptyRef = useRef(true);
  const wasSuspendedRef = useRef(false);
  const writerRef = useRef<ComposerDraftWriter | null>(null);
  const [sendInFlight, setSendInFlight] = useState(false);
  const [stored, setStored] = useState<ComposerDraftEntry | null>(() => readComposerDraftEntry(key));

  useEffect(() => {
    const writer = createComposerDraftWriter({
      delayMs: COMPOSER_DRAFT_DEBOUNCE_MS,
      onCommitted: (committedKey, entry) => {
        if (committedKey === keyRef.current) setStored(entry);
      },
      onRemoved: (removedKey) => {
        if (removedKey === keyRef.current) setStored(null);
      },
    });
    writerRef.current = writer;
    return () => {
      writer.dispose();
      if (writerRef.current === writer) writerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onAdopted = () => setStored(readComposerDraftEntry(keyRef.current));
    window.addEventListener(COMPOSER_DRAFT_ADOPTED_EVENT, onAdopted);
    return () => window.removeEventListener(COMPOSER_DRAFT_ADOPTED_EVENT, onAdopted);
  }, []);

  useEffect(() => {
    const writer = writerRef.current;
    if (!writer) return;
    if (suspend) {
      // The box now shows a queued message. Flush the idle draft that was already
      // scheduled, and don't replace it with the queued body.
      if (!wasSuspendedRef.current) writer.flushPending();
      wasSuspendedRef.current = true;
      if (prevKeyRef.current !== key) {
        prevKeyRef.current = key;
        keyRef.current = key;
        ignoreNextEmptyRef.current = true;
        setStored(readComposerDraftEntry(key));
      }
      return;
    }
    if (wasSuspendedRef.current) {
      wasSuspendedRef.current = false;
      ignoreNextEmptyRef.current = true;
    }
    if (prevKeyRef.current !== key) {
      const previousKey = prevKeyRef.current;
      prevKeyRef.current = key;
      keyRef.current = key;
      // Session switch clears the box in a later effect. This render still has
      // the previous session's text and attachments, so flush them onto the previous key first.
      if (hasComposerDraftContent(valueRef.current, attachmentsRef.current)) {
        writer.flushNow(previousKey, valueRef.current, () => false, attachmentsRef.current);
      } else {
        writer.flushPending();
      }
      ignoreNextEmptyRef.current = true;
      setStored(readComposerDraftEntry(key));
      return;
    }
    keyRef.current = key;
    if (!hasComposerDraftContent(value, attachments) && ignoreNextEmptyRef.current) {
      // Mount and the post-switch clear both start from an empty box. That
      // empty state is not the user deleting the stored draft.
      ignoreNextEmptyRef.current = false;
      return;
    }
    ignoreNextEmptyRef.current = false;
    writer.schedule(key, value, () => sendInFlightRef.current, attachments);
  }, [attachments, key, suspend, value]);

  const noteOptimisticClear = useCallback(() => {
    sendInFlightRef.current = true;
    setSendInFlight(true);
    sendKeyRef.current = keyRef.current;
    // Hold, do not remove. Success is the only outcome that deletes.
    writerRef.current?.flushNow(
      keyRef.current,
      valueRef.current,
      () => true,
      attachmentsRef.current,
    );
  }, []);

  const noteSendSettled = useCallback((outcome: ComposerDraftSendOutcome) => {
    sendInFlightRef.current = false;
    setSendInFlight(false);
    const sendKey = sendKeyRef.current;
    sendKeyRef.current = null;
    // Cancel the empty-box schedule captured during the optimistic clear so it
    // cannot remove the draft once the in-flight flag drops.
    writerRef.current?.cancel();
    if (outcome !== 'success') return;
    // Delete the draft of the session that sent. If the user switched sessions
    // mid-send, the current session's stored draft and notice stay untouched.
    removeComposerDraft(sendKey);
    if (sendKey === keyRef.current) setStored(null);
  }, []);

  const trackSend = useCallback(async (send: () => boolean | Promise<boolean>) => {
    noteOptimisticClear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        Promise.resolve().then(send),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), COMPOSER_DRAFT_SEND_TIMEOUT_MS);
        }),
      ]);
      if (raced === 'timeout') {
        noteSendSettled('timeout');
        return 'timeout' as const;
      }
      const ok = raced === true;
      noteSendSettled(ok ? 'success' : 'failure');
      return ok;
    } catch (error) {
      noteSendSettled('failure');
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, [noteOptimisticClear, noteSendSettled]);

  const putBack = useCallback(() => {
    const entry = readComposerDraftEntry(keyRef.current);
    if (!entry) return;
    const hasText = Boolean(entry.text.trim());
    const hasAttachments = entry.attachments.length > 0;
    if (!hasText && !hasAttachments) return;
    if (hasText) {
      setValue(entry.text);
    }
    if (hasAttachments && setAttachments) {
      const { attachments: merged } = mergeAttachments(
        attachmentsRef.current,
        entry.attachments,
        UI.MAX_ATTACHMENTS_DROP,
      );
      setAttachments(merged);
    }
  }, [setAttachments, setValue]);

  const discard = useCallback(() => {
    writerRef.current?.cancel();
    removeComposerDraft(keyRef.current);
    setStored(null);
  }, []);

  const notice: ComposerDraftNotice | null =
    sendInFlight || hasComposerDraftContent(value, attachments) || !stored
      ? null
      : {
          text: stored.text,
          preview: stored.text.trim() ? composerDraftPreview(stored.text) : '',
          attachmentNames: stored.attachments.map((att) => att.name.split(/[\\/]/).pop() || att.name),
          droppedNames: stored.dropped,
        };

  return {
    notice,
    putBack,
    discard,
    noteOptimisticClear,
    noteSendSettled,
    trackSend,
  };
}
