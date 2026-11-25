import { useRef, useState } from 'react';
import type { Message } from '@shared/contract';
import { generateMessageId } from '@shared/utils/id';
import { useSessionTurnActive, isSessionTurnActiveNow } from './useSessionTurnActive';
import { useMessageActionStore } from '../stores/messageActionStore';
import { useSessionStore } from '../stores/sessionStore';

function delegationRetryAlreadySent(
  messages: readonly Message[] | undefined,
  prefix: string,
  endedAt: number | undefined,
): boolean {
  return Boolean(prefix && messages?.some((message) =>
    message.role === 'user' && message.id?.startsWith(prefix)
      && (endedAt === undefined || message.timestamp > endedAt),
  ));
}

export function useDelegationRetry(
  targetSessionId: string | undefined,
  prefix: string,
  endedAt?: number,
  openSession = false,
) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const messages = useSessionStore((state) => state.messages);
  const sessionId = targetSessionId ?? currentSessionId;
  const active = useSessionTurnActive(sessionId);
  const busy = useRef(false);
  const [sent, setSent] = useState(false);
  const inSession = sessionId === currentSessionId;
  const alreadySent = inSession && delegationRetryAlreadySent(messages, prefix, endedAt);
  const unavailable = !sessionId || !prefix || active || (!inSession && !openSession);

  const send = async (prompt: string) => {
    if (unavailable || sent || alreadySent || busy.current) return;
    busy.current = true;
    setSent(true);
    try {
      if (!inSession) {
        await useSessionStore.getState().switchSession(sessionId);
        const session = useSessionStore.getState();
        if (session.currentSessionId !== sessionId || session.error || isSessionTurnActiveNow(sessionId)
            || delegationRetryAlreadySent(session.messages, prefix, endedAt)) {
          setSent(false);
          return;
        }
      }
      await useMessageActionStore.getState().sendPrompt(prompt, {
        clientMessageId: `${prefix}${generateMessageId()}`,
      });
    } finally {
      busy.current = false;
    }
  };

  return { disabled: unavailable || sent || alreadySent, showBusyHint: unavailable && !sent, send };
}
