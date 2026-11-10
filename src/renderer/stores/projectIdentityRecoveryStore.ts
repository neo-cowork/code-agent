import { create } from 'zustand';
import type { Message } from '@shared/contract';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import { PROJECT_IDENTITY_CONFIRMATION } from '@shared/constants/projectIdentityConfirmation';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { useAppStore } from './appStore';
import { useSessionStore } from './sessionStore';
import { useTaskStore } from './taskStore';
import { getHttpFailureMessage } from '../utils/httpFailureMessage';
import { replaceOptimisticUserMessage, markOptimisticUserSendFailed } from '../utils/optimisticUserSend';

type Recovery = { token: string; envelope: ConversationEnvelope; userMessage: Message; phase: 'pending' | 'confirming' | 'closed' };
type State = { entries: Record<string, Recovery>; dismiss: (messageId: string) => void; confirm: (messageId: string) => Promise<void> };

export const useProjectIdentityRecoveryStore = create<State>((set, get) => ({
  entries: {},
  dismiss: messageId => {
    const recovery = get().entries[messageId];
    if (recovery?.phase !== 'pending') return;
    set(state => ({ entries: { ...state.entries, [messageId]: { ...recovery, phase: 'closed' } } }));
  },
  confirm: async messageId => {
    const recovery = get().entries[messageId];
    if (recovery?.phase !== 'pending' || !recovery.envelope.sessionId) return;
    const sessionId = recovery.envelope.sessionId;
    set(state => ({ entries: { ...state.entries, [messageId]: { ...recovery, phase: 'confirming' } } }));
    try {
      const result = await ipcService.invokeDomain<{ confirmed: true }>(IPC_DOMAINS.PROJECT, 'confirmMissingSourceIdentity', {
        sessionId, token: recovery.token, confirmed: true,
      });
      if (result?.confirmed !== true) throw new Error('PROJECT_IDENTITY_CONFIRMATION_FAILED');
      // The confirmed envelope is the exact failed send, including attachments and message id.
      replaceOptimisticUserMessage(recovery.userMessage);
      useAppStore.getState().setSessionProcessing(sessionId, true);
      useTaskStore.getState().updateSessionState(sessionId, { status: 'running', startTime: Date.now() });
      await ipcService.invoke('agent:send-message', recovery.envelope);
      useSessionStore.getState().updateMessage(messageId, { content: '' });
    } catch {
      markOptimisticUserSendFailed(recovery.userMessage.id);
      useAppStore.getState().setSessionProcessing(sessionId, false);
      useTaskStore.getState().updateSessionState(sessionId, { status: 'error' });
      useSessionStore.getState().updateMessage(messageId, { content: getHttpFailureMessage(422, 'PROJECT_SOURCE_TRUST') });
    } finally {
      set(state => ({ entries: { ...state.entries, [messageId]: { ...recovery, phase: 'closed' } } }));
    }
  },
}));

/** No persistence or consent side effects: merely offer the action on this failed message. */
export function offerProjectIdentityRecovery(messageId: string, error: unknown, envelope: ConversationEnvelope, userMessage: Message): void {
  if (!(error instanceof Error) || !('code' in error) || error.code !== PROJECT_IDENTITY_CONFIRMATION.CODE
    || !('recoveryToken' in error) || typeof error.recoveryToken !== 'string') return;
  useProjectIdentityRecoveryStore.setState(state => ({ entries: { ...state.entries,
    [messageId]: { token: error.recoveryToken as string, envelope: structuredClone(envelope), userMessage, phase: 'pending' },
  } }));
}
