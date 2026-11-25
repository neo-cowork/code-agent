import { useEffect, useRef, type RefObject } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import { useI18n } from '../../../../hooks/useI18n';
import { ipcService } from '../../../../services/ipcService';
import { cronClient } from '../../../../services/cronClient';
import { useServerConnectionStore } from '../../../../stores/serverConnectionStore';
import { buildPendingScheduleDraft, type PendingScheduleDraft, type ScheduleDraftController } from './useScheduleDraft';

type DraftState = Pick<ScheduleDraftController, 'pendingScheduleDraft' | 'storePendingScheduleDraft'>
  & Required<Pick<ScheduleDraftController, 'clearRequestDraft'>>;

/** The event wakes the composer. The session's host entry is the source of truth. */
export function useScheduleDraftRequest(
  sessionId: string | null,
  creating: boolean,
  { pendingScheduleDraft, storePendingScheduleDraft, clearRequestDraft }: DraftState,
  formRef: RefObject<HTMLFormElement | null>,
): void {
  const { language } = useI18n();
  const latest = useRef({ creating, pendingScheduleDraft, language });
  latest.current = { creating, pendingScheduleDraft, language };
  const wake = useRef<() => void>(undefined);
  const eventStreamRevision = useServerConnectionStore((state) => state.eventStreamRevision);

  useEffect(() => {
    if (!sessionId) return;
    let stopped = false;
    let queued = false;
    let running = false;

    const reconcile = async () => {
      const request = await cronClient.getScheduleDraftRequest(sessionId);
      if (stopped) return;
      const current = latest.current.pendingScheduleDraft;
      if (current?.requestId && current.sourceSessionId === sessionId) {
        if (current.requestId === request?.requestId) return;
        clearRequestDraft({ sessionId, requestId: current.requestId });
      }
      if (!request || latest.current.creating) return;

      const { requestId, description } = request;
      const ref = { sessionId, requestId };
      let raw: Record<string, unknown> | undefined;
      let pending: PendingScheduleDraft | null;
      try {
        raw = request.state === 'requested' ? await cronClient.generateFromPrompt(description, latest.current.language) : request.draft;
        pending = buildPendingScheduleDraft(raw, description, sessionId);
      } catch {
        pending = null;
      }

      if (!pending || !raw) {
        await cronClient.ackScheduleDraft({ ...ref, status: 'generation_failed' });
        return;
      }
      if (request.state === 'requested') {
        const accepted = await cronClient.ackScheduleDraft({ ...ref, status: 'prepared', draft: raw });
        if (!accepted) {
          queued = true;
          return;
        }
      }
      if (!stopped && !latest.current.creating) storePendingScheduleDraft({ ...pending, requestId });
    };

    const refresh = () => {
      queued = true;
      if (running || stopped || latest.current.creating) return;
      running = true;
      void (async () => {
        try {
          while (queued && !stopped && !latest.current.creating) {
            queued = false;
            await reconcile();
          }
        } catch {
          // On transport loss the next connection refreshes the request. The host bounds the wait.
        } finally {
          running = false;
          if (queued && !stopped && !latest.current.creating) refresh();
        }
      })();
    };

    wake.current = refresh;
    const unsubscribe = ipcService.on(IPC_CHANNELS.AGENT_EVENT, (event) => {
      if (event.type === 'schedule_draft_requested' && event.data?.sessionId === sessionId) refresh();
    });
    window.addEventListener('focus', refresh);
    refresh();
    return () => {
      stopped = true;
      wake.current = undefined;
      unsubscribe?.();
      window.removeEventListener('focus', refresh);
    };
  }, [clearRequestDraft, sessionId, storePendingScheduleDraft]);

  useEffect(() => {
    wake.current?.();
  }, [creating, eventStreamRevision]);

  const requestId = pendingScheduleDraft?.requestId;
  const draftSessionId = pendingScheduleDraft?.sourceSessionId;
  useEffect(() => {
    const form = formRef.current;
    if (!sessionId || draftSessionId !== sessionId || !requestId || !form) return;
    let stopped = false;
    let sending = false;
    let frame = 0;
    const ref = { sessionId, requestId };
    const checkVisibility = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (stopped || sending || document.visibilityState === 'hidden') return;
        const card = form.querySelector('[data-schedule-confirm]');
        if (!card?.getClientRects().length || getComputedStyle(card).visibility === 'hidden') return;
        sending = true;
        void cronClient.ackScheduleDraft({ ...ref, status: 'shown' })
          .then((accepted) => { if (!accepted && !stopped) clearRequestDraft(ref); })
          .catch(() => { sending = false; });
      });
    };
    // ComposerSlot may mount the card on a later commit or after a blocking notice clears.
    const observer = new MutationObserver(checkVisibility);
    observer.observe(form, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
    document.addEventListener('visibilitychange', checkVisibility);
    window.addEventListener('focus', checkVisibility);
    checkVisibility();
    return () => {
      stopped = true;
      observer.disconnect();
      document.removeEventListener('visibilitychange', checkVisibility);
      window.removeEventListener('focus', checkVisibility);
      cancelAnimationFrame(frame);
    };
  }, [clearRequestDraft, draftSessionId, eventStreamRevision, formRef, requestId, sessionId]);
}
