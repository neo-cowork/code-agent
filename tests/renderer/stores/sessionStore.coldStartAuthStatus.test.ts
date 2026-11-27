import { expect, it, vi } from 'vitest';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../../src/shared/constants';
import { initializeSessionStore, reloadSessionsForAuthChange, useSessionStore } from '../../../src/renderer/stores/sessionStore';

it('keeps currentSessionId and messages on principalChanged:false reload, and reuses single blank 新对话 on no-memory cold start', async () => {
  // Part 1: no-memory cold start — boot list has one blank "新对话", followed by principalChanged:false reload
  const blankSession = { id: 'blank-1', title: '新对话', messageCount: 0, turnCount: 0, createdAt: 10, updatedAt: 10 };
  const invokeCold = vi.fn(async (_domain: string, action: string) => {
    if (action === 'list') return { success: true, data: [blankSession] };
    if (action === 'load') return { success: true, data: { ...blankSession, messages: [], todos: [] } };
    if (action === 'create') return { success: true, data: { id: 'blank-2', title: '新对话', messageCount: 0, turnCount: 0, createdAt: 11, updatedAt: 11 } };
    return { success: true, data: [] };
  });
  (globalThis as Record<string, unknown>).window = { domainAPI: { invoke: invokeCold }, electronAPI: { on: vi.fn(() => () => {}) } };

  await initializeSessionStore();
  await reloadSessionsForAuthChange({ principalChanged: false });

  expect(useSessionStore.getState().currentSessionId).toBe('blank-1');
  expect(invokeCold.mock.calls.filter(([, action]) => action === 'create')).toHaveLength(0);

  // Part 2: with a current session and messages already in the store, principalChanged:false keeps both
  const existingMsg = {
    id: 'm1',
    role: 'user' as const,
    content: 'Turn notes into 3 key points',
    timestamp: 100,
  };
  useSessionStore.setState({
    currentSessionId: 'chat-1',
    sessions: [{ id: 'chat-1', title: 'Notes summary', modelConfig: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }, messageCount: 1, turnCount: 1, createdAt: 1, updatedAt: 2 }],
    messages: [existingMsg],
  });

  const invokeRemembered = vi.fn(async (_domain: string, action: string) => {
    if (action === 'list') {
      return {
        success: true,
        data: [{ id: 'chat-1', title: 'Notes summary', messageCount: 1, turnCount: 1, createdAt: 1, updatedAt: 2 }],
      };
    }
    return { success: true, data: null };
  });
  (globalThis as Record<string, unknown>).window = { domainAPI: { invoke: invokeRemembered }, electronAPI: { on: vi.fn(() => () => {}) } };

  await reloadSessionsForAuthChange({ principalChanged: false });
  expect(useSessionStore.getState().currentSessionId).toBe('chat-1');
  expect(useSessionStore.getState().messages).toHaveLength(1);
  expect(useSessionStore.getState().messages[0]?.id).toBe('m1');
});
