// @vitest-environment jsdom
// 强刷当前会话（终态对账 / snapshot 补灌）不是「打开」：不能清掉刚留下的未读点。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import type { Session } from '../../../src/shared/contract';

const mockDomainInvoke = vi.fn();
const mockInvoke = vi.fn();

function makeSession(id: string): Session {
  return {
    id, title: `会话 ${id}`, modelConfig: { provider: 'zhipu', model: 'glm-5' },
    createdAt: 1, updatedAt: 1, messages: [], todos: [],
  } as unknown as Session;
}

describe('switchSession unread handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
      electronAPI: { invoke: mockInvoke, on: vi.fn(() => () => {}), off: vi.fn() },
    };
    useSessionStore.setState({
      sessions: [makeSession('a'), makeSession('b')] as unknown as ReturnType<typeof useSessionStore.getState>['sessions'],
      currentSessionId: 'a', messages: [], todos: [], sessionTasks: [], streamSnapshot: null,
      isLoading: false, error: null, unreadSessionIds: new Set<string>(),
      runningSessionIds: new Set<string>(), sessionRuntimes: new Map(), backgroundSessions: [],
      hasOlderMessages: false, isLoadingOlder: false, sessionDesignBriefs: new Map(),
    });
    mockDomainInvoke.mockImplementation(async (_d: string, op: string, p?: { sessionId?: string }) => {
      if (op === 'load') return makeSession(p?.sessionId || 'a');
      if (op === 'getSessionTasks') return [];
      return null;
    });
  });

  const unread = () => [...useSessionStore.getState().unreadSessionIds].sort();

  it('force reload of the current session keeps its unread dot', async () => {
    useSessionStore.getState().markSessionUnread('a', { includeCurrent: true });
    await useSessionStore.getState().switchSession('a', { force: true });
    expect(unread()).toEqual(['a']);
  });

  it('a dot added while the forced reload is still loading survives the load result', async () => {
    const pending = useSessionStore.getState().switchSession('a', { force: true });
    useSessionStore.getState().markSessionUnread('a', { includeCurrent: true });
    await pending;
    expect(unread()).toEqual(['a']);
  });

  it('opening another unread session clears only that session', async () => {
    useSessionStore.getState().markSessionUnread('a', { includeCurrent: true });
    useSessionStore.getState().markSessionUnread('b');
    await useSessionStore.getState().switchSession('b');
    expect(unread()).toEqual(['a']);
  });
});
