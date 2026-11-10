// @vitest-environment jsdom
import { act, render, renderHook, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
const invoke = vi.hoisted(() => vi.fn());
const invokeDomain = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invoke, invokeDomain } }));
import { useAgentIPC } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { ProjectIdentityRecovery } from '../../../src/renderer/components/features/chat/ProjectIdentityRecovery';
import { useProjectIdentityRecoveryStore } from '../../../src/renderer/stores/projectIdentityRecoveryStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

const envelope: ConversationEnvelope = { content: '帮我把下载文件夹里的照片按日期改名', sessionId: 'photos', clientMessageId: 'original-message' };
const sentence = '此文件夹需要重新确认，请确认信任后继续发送。';
beforeEach(() => {
  invoke.mockReset(); invokeDomain.mockReset();
  useProjectIdentityRecoveryStore.setState({ entries: {} });
  useSessionStore.setState({ currentSessionId: 'photos', messages: [] });
  useAppStore.setState({ language: 'zh', isProcessing: false, processingSessionIds: new Set() });
  useTaskStore.setState({ sessionStates: { photos: { status: 'idle' } } });
});
afterEach(cleanup);
async function failedSend() {
  invoke.mockRejectedValueOnce(Object.assign(new Error(sentence), { status: 422, code: 'PROJECT_SOURCE_IDENTITY_CONFIRM_REQUIRED',
    recoveryToken: '11111111-1111-4111-8111-111111111111' }));
  const hook = renderHook(() => useAgentIPC({ addMessage: useSessionStore.getState().addMessage, currentSessionId: 'photos',
    currentTurnMessageIdRef: { current: null }, isProcessing: false, setIsProcessing: vi.fn(),
    setSessionProcessing: useAppStore.getState().setSessionProcessing }));
  await act(async () => { await hook.result.current.sendMessage(envelope); });
  const message = useSessionStore.getState().messages.find(m => m.role === 'assistant');
  if (!message) throw new Error('Missing failure message');
  expect(message.content).toBe(sentence);
  render(<ProjectIdentityRecovery messageId={message.id} />);
  return message;
}
it('one confirm button records consent and automatically re-sends the exact original envelope once', async () => {
  const message = await failedSend();
  const original = invoke.mock.calls[0][1];
  expect(invokeDomain).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledTimes(1);
  invokeDomain.mockResolvedValue({ confirmed: true }); invoke.mockResolvedValue(undefined);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认信任并发送' })); });
  expect(invokeDomain).toHaveBeenCalledWith('domain:project', 'confirmMissingSourceIdentity', {
    sessionId: 'photos', token: '11111111-1111-4111-8111-111111111111', confirmed: true,
  });
  expect(invoke).toHaveBeenCalledTimes(2); expect(invoke.mock.calls[1]).toEqual(['agent:send-message', original]);
  expect(useSessionStore.getState().messages.find(m => m.id === message.id)?.content).toBe('');
  expect(useSessionStore.getState().messages.filter(m => m.role === 'user')).toHaveLength(1);
});
it('decline closes the action while retaining the same sentence and the unsent original', async () => {
  const message = await failedSend(); fireEvent.click(screen.getByRole('button', { name: '暂不确认' }));
  expect(invokeDomain).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: '确认信任并发送' })).toBeNull();
  expect(useSessionStore.getState().messages.find(m => m.id === message.id)?.content).toBe(sentence);
  expect(useSessionStore.getState().messages.find(m => m.role === 'user')?.metadata?.sendFailed).toBe(true);
});
it('leaving the prompt unclicked has no consent or retry side effect', async () => {
  await failedSend(); cleanup();
  expect(invokeDomain).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledTimes(1);
});
