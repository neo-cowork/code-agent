// ============================================================================
// useNeoWorkCardContinuationSend — 工作卡「接着做」的发送包装
// ----------------------------------------------------------------------------
// 详情里点「接着做」只把目标记在 store 上。这条包装在目标所属会话里把下一条发送
// 改成同卡续接（submitNeoTagContinuation → continueAndRun），其它情况原样透传。
// 切会话时清掉目标，但刚写上、目的地就是这次要打开的会话时保留。
// ============================================================================

import { useCallback } from 'react';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import { toast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { useNeoWorkCardStore } from '../../../stores/neoWorkCardStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { buildNeoTagContinuationMessage, submitNeoTagContinuation } from './neoTagSubmit';

type SendEnvelopeFn = (envelope: ConversationEnvelope) => Promise<boolean>;

useSessionStore.subscribe((state, previous) => {
  if (state.currentSessionId === previous.currentSessionId) return;
  const { continuationTarget, setContinuationTarget } = useNeoWorkCardStore.getState();
  // 接着做先写入目标再打开会话。到达目标会话时保留标记。
  if (continuationTarget && continuationTarget.conversationId !== state.currentSessionId) {
    setContinuationTarget(null);
  }
});

/**
 * 发送包装：当前会话与续接目标的 conversationId 一致时走同卡续接。
 * 失败 toast 并保留目标（草稿可重发）；成功后补上本地用户消息并清掉目标。
 */
export function useNeoWorkCardContinuationSend(send: SendEnvelopeFn): SendEnvelopeFn {
  return useCallback(async (envelope) => {
    const sessionId = useSessionStore.getState().currentSessionId;
    const target = useNeoWorkCardStore.getState().continuationTarget;
    if (target?.conversationId !== sessionId || (envelope.sessionId && envelope.sessionId !== sessionId)) {
      return await send(envelope);
    }
    try {
      const continuation = await submitNeoTagContinuation({
        envelope,
        conversationId: sessionId,
        continuationTarget: target,
        requesterUserId: useAuthStore.getState().user?.id ?? 'local-user',
        runContinuation: useNeoWorkCardStore.getState().continueAndRun,
      });
      const roundMessage = buildNeoTagContinuationMessage({
        envelope,
        conversationId: sessionId,
        workCardId: target.workCardId,
        roundTurnId: continuation.roundTurnId,
      });
      const session = useSessionStore.getState();
      if (session.currentSessionId === sessionId && !session.messages.some((message) => message.id === roundMessage.id)) {
        session.addMessage(roundMessage);
      }
      const workCard = useNeoWorkCardStore.getState();
      if (workCard.continuationTarget === target) {
        workCard.setContinuationTarget(null);
      }
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [send]);
}
