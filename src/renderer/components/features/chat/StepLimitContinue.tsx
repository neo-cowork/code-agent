import React, { useCallback } from 'react';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { useSessionTurnActive } from '../../../hooks/useSessionTurnActive';
import { useSessionStore } from '../../../stores/sessionStore';
import { useMessageActionStore } from '../../../stores/messageActionStore';

/** Send another ordinary user turn; never resume a parked run. */
export function useStepLimitContinue(sessionId: string | null | undefined) {
  const { t } = useI18n();
  const lastMessage = useSessionStore((state) => (
    sessionId && state.currentSessionId === sessionId ? state.messages.at(-1) : undefined
  ));
  const active = useSessionTurnActive(sessionId);
  const available = !active && lastMessage?.role === 'assistant'
    && lastMessage.metadata?.stoppedByStepLimit === true;
  const continueTurn = useCallback(async () => {
    const state = useSessionStore.getState();
    if (!available || !sessionId || state.currentSessionId !== sessionId
      || state.messages.at(-1)?.id !== lastMessage?.id || state.isSessionRunning(sessionId)) return;
    await useMessageActionStore.getState().sendPrompt(t.chatInput.stepLimitContinue, {
      // Double clicks share ordinary send idempotency; the next summary has a new id.
      clientMessageId: `continue-${lastMessage.id}`,
    });
  }, [available, lastMessage?.id, sessionId, t.chatInput.stepLimitContinue]);
  return { available, messageId: lastMessage?.id, continueTurn };
}

export function StepLimitContinue({ sessionId, messageId }: { sessionId?: string; messageId: string }) {
  const { t } = useI18n();
  const continuation = useStepLimitContinue(sessionId);
  if (!continuation.available || continuation.messageId !== messageId) return null;
  return (
    <div className="mt-3" data-testid="step-limit-continue">
      <Button size="sm" variant="secondary" onClick={() => void continuation.continueTurn()}>
        {t.chatInput.stepLimitContinue}
      </Button>
    </div>
  );
}
