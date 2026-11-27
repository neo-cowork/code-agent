// ============================================================================
// useNeoWorkCardContinuationSend — 工作卡「接着做」的发送包装
// ----------------------------------------------------------------------------
// 详情里点「接着做」只把目标记在 store 上。这条包装在目标所属会话里把下一条发送
// 改成同卡续接（submitNeoTagContinuation → continueAndRun），其它情况原样透传。
// 切会话时清掉目标，但刚写上、目的地就是这次要打开的会话时保留。
// ============================================================================

import { useCallback } from 'react';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { useAppStore } from '../../../stores/appStore';
import { useAuthStore } from '../../../stores/authStore';
import { useNeoWorkCardStore } from '../../../stores/neoWorkCardStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { buildNeoTagContinuationMessage, submitNeoTagContinuation } from './neoTagSubmit';

type SendEnvelopeFn = (envelope: ConversationEnvelope) => Promise<boolean>;

/**
 * 会话里已经绑着的专家会被 buildEnvelope 写成 preferredAgentId + selectedAgent.via=agent_chip，
 * 那不是这一轮新选的。这一轮才挡：slash /agent 或命令面板留下的 via、正文里的 @提及，
 * 以及和当前会话 activeAgentId 对不上的专家。
 */
function hasPerTurnExpertChoice(
  context: ConversationEnvelope['context'],
  activeAgentId: string | null,
): boolean {
  if (!context) return false;
  const mentioned = context.routing?.mode === 'direct' ? context.routing.targetAgentIds : undefined;
  if (mentioned && mentioned.length > 0) return true;
  const selected = context.selectedAgent;
  if (selected?.via === 'slash_picker' || selected?.via === 'agent_command') return true;
  if (selected?.id && !(selected.via === 'agent_chip' && selected.id === activeAgentId)) return true;
  return Boolean(context.preferredAgentId && context.preferredAgentId !== activeAgentId);
}

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
  const { t } = useI18n();
  return useCallback(async (envelope) => {
    const sessionId = useSessionStore.getState().currentSessionId;
    const target = useNeoWorkCardStore.getState().continuationTarget;
    if (target?.conversationId !== sessionId || (envelope.sessionId && envelope.sessionId !== sessionId)) {
      return await send(envelope);
    }
    if (envelope.attachments?.length) {
      toast.error(t.neoContinuation.attachmentsUnsupported);
      return false;
    }
    if (envelope.context?.artifactReferences?.length || envelope.context?.sessionReferences?.length) {
      toast.error(t.neoContinuation.referencesUnsupported);
      return false;
    }
    const ctx = envelope.context;
    if (
      ctx?.selectedSkillIds?.length || ctx?.selectedConnectorIds?.length || ctx?.selectedMcpServerIds?.length
      || hasPerTurnExpertChoice(ctx, useAppStore.getState().activeAgentId)
    ) {
      toast.error(t.neoContinuation.selectionsUnsupported);
      return false;
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
  }, [send, t.neoContinuation.attachmentsUnsupported, t.neoContinuation.referencesUnsupported, t.neoContinuation.selectionsUnsupported]);
}
