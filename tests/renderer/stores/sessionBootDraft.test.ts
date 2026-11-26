// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  composerDraftStorageKey,
  readComposerDraft,
} from '../../../src/renderer/components/features/chat/ChatInput/composerDraftStore';
import { openInitialSession } from '../../../src/renderer/stores/sessionBootDraft';

const mockDomainInvoke = vi.fn();

function wireSession(id: string, title: string, messageCount: number, updatedAt: number) {
  return {
    id,
    title,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt,
    messageCount,
    turnCount: messageCount,
  };
}

function storeDraft(sessionId: string | null, text: string) {
  localStorage.setItem(composerDraftStorageKey(sessionId, false)!, JSON.stringify({ v: 1, text }));
}

describe('cold boot lands on the session that holds the unsent draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
    (globalThis as Record<string, unknown>).window = Object.assign(window, {
      domainAPI: { invoke: mockDomainInvoke },
    });
  });

  it('initializeSessionStore opens the blank draft session even when another session is newer', async () => {
    storeDraft('blank', 'long task description typed on the home box');
    const list = [wireSession('busy', '其他任务', 3, 20), wireSession('blank', '新对话', 0, 10)];
    mockDomainInvoke.mockImplementation(async (_d: string, action: string, payload?: { sessionId?: string }) => {
      if (action === 'list') return { success: true, data: list };
      if (action === 'load') {
        const found = list.find((s) => s.id === payload?.sessionId) ?? list[0];
        return { success: true, data: { ...found, messages: [], todos: [] } };
      }
      return { success: true, data: [] };
    });
    const { initializeSessionStore, useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    await initializeSessionStore();
    expect(useSessionStore.getState().currentSessionId).toBe('blank');
  });

  it('re-sign-in at boot (auth change) also reopens the blank draft session', async () => {
    storeDraft('blank', 'draft typed before the account state flipped');
    const list = [wireSession('busy', '其他任务', 3, 20), wireSession('blank', '新对话', 0, 10)];
    mockDomainInvoke.mockImplementation(async (_d: string, action: string, payload?: { sessionId?: string }) => {
      if (action === 'list') return { success: true, data: list };
      if (action === 'load') {
        const found = list.find((s) => s.id === payload?.sessionId) ?? list[0];
        return { success: true, data: { ...found, messages: [], todos: [] } };
      }
      return { success: true, data: [] };
    });
    const { initializeSessionStore, reloadSessionsForAuthChange, useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    await initializeSessionStore();
    await reloadSessionsForAuthChange({ principalChanged: true });
    expect(useSessionStore.getState().currentSessionId).toBe('blank');
  });

  it('initializeSessionStore never falls back to the newest chat when no blank session holds a draft', async () => {
    storeDraft('busy', 'draft in a session that already has messages');
    const list = [wireSession('busy', '其他任务', 3, 20), wireSession('blank', '新对话', 0, 10)];
    mockDomainInvoke.mockImplementation(async (_d: string, action: string, payload?: { sessionId?: string }) => {
      if (action === 'list') return { success: true, data: list };
      if (action === 'load') {
        const found = list.find((s) => s.id === payload?.sessionId) ?? list[0];
        return { success: true, data: { ...found, messages: [], todos: [] } };
      }
      return { success: true, data: [] };
    });
    const { initializeSessionStore, useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    await initializeSessionStore();
    expect(useSessionStore.getState().currentSessionId).not.toBe('busy');
  });

  it('with no sessions the home draft moves onto the created session and the home key is cleared', async () => {
    storeDraft(null, 'typed while no session existed');
    const switchSession = vi.fn();
    await openInitialSession({
      sessions: [], isBlank: () => true, switchSession, createSession: async () => ({ id: 'fresh' }),
    });
    expect(switchSession).not.toHaveBeenCalled();
    expect(readComposerDraft(composerDraftStorageKey('fresh', false))).toBe('typed while no session existed');
    expect(readComposerDraft(composerDraftStorageKey(null, false))).toBeNull();
  });

  it('never overwrites an existing draft on the created session', async () => {
    storeDraft(null, 'home text');
    storeDraft('fresh', 'session text');
    await openInitialSession({
      sessions: [], isBlank: () => true, switchSession: vi.fn(), createSession: async () => ({ id: 'fresh' }),
    });
    expect(readComposerDraft(composerDraftStorageKey('fresh', false))).toBe('session text');
  });

  it('skips blank sessions that hold no draft', async () => {
    storeDraft('b2', 'x');
    const switchSession = vi.fn();
    await openInitialSession({
      sessions: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }],
      isBlank: (s) => s.id !== 'b3',
      switchSession,
      createSession: vi.fn(),
    });
    expect(switchSession).toHaveBeenCalledWith('b2');
  });
});

describe('cold boot keeps the chat the user was viewing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
    (globalThis as Record<string, unknown>).window = Object.assign(window, {
      domainAPI: { invoke: mockDomainInvoke },
    });
  });

  const sessions = [{ id: 'target' }, { id: 'origin' }];
  const open = async () => {
    const switchSession = vi.fn(async () => undefined);
    await openInitialSession({ sessions, isBlank: () => false, switchSession, createSession: async () => null });
    return switchSession;
  };

  it('opens the last viewed chat even when a delegation target was updated after it', async () => {
    const { rememberLastViewedSession } = await import('../../../src/renderer/stores/sessionBootDraft');
    rememberLastViewedSession('origin');
    expect(await open()).toHaveBeenCalledWith('origin');
  });

  it('opens the new-task start page (createSession) when nothing is remembered or the remembered chat is gone', async () => {
    const createSession = vi.fn(async () => ({ id: 'fresh' }));
    const run = async () => {
      const switchSession = vi.fn(async () => undefined);
      await openInitialSession({ sessions, isBlank: () => false, switchSession, createSession });
      return switchSession;
    };
    expect(await run()).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledTimes(1);
    const { rememberLastViewedSession } = await import('../../../src/renderer/stores/sessionBootDraft');
    rememberLastViewedSession('deleted');
    expect(await run()).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('records the visible chat as soon as the user switches (real store + broadcasts wiring)', async () => {
    mockDomainInvoke.mockImplementation(async (_d: string, action: string, payload?: { sessionId?: string }) => (
      action === 'load'
        ? { success: true, data: { ...wireSession(payload?.sessionId ?? 'x', 't', 1, 1), messages: [], todos: [] } }
        : { success: true, data: [wireSession('target', 'T', 1, 20), wireSession('origin', 'O', 1, 10)] }
    ));
    const { initializeSessionStore, useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    await initializeSessionStore();
    await useSessionStore.getState().switchSession('origin');
    expect(localStorage.getItem('neo:last-viewed-session')).toBe('origin');
  });
});

describe('cold boot through the production entries (initializeSessionStore / reloadSessionsForAuthChange)', () => {
  const list = [wireSession('busy', '其他任务', 3, 20), wireSession('older', '更早的任务', 2, 10)];
  const calls: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
    calls.length = 0;
    (globalThis as Record<string, unknown>).window = Object.assign(window, {
      domainAPI: { invoke: mockDomainInvoke },
    });
    mockDomainInvoke.mockImplementation(async (_d: string, action: string, payload?: { sessionId?: string }) => {
      calls.push(action);
      if (action === 'list') return { success: true, data: list };
      if (action === 'load') {
        const found = list.find((s) => s.id === payload?.sessionId);
        return { success: true, data: found ? { ...found, messages: [], todos: [] } : null };
      }
      if (action === 'create') return { success: true, data: { ...wireSession('created', '新对话', 0, 99) } };
      return { success: true, data: [] };
    });
  });

  it('(a) empty localStorage: lands on a new blank session, not any existing chat, and the start page applies', async () => {
    const { initializeSessionStore, useSessionStore, isBlankNewSession } = await import('../../../src/renderer/stores/sessionStore');
    await initializeSessionStore();
    const state = useSessionStore.getState();
    expect(state.currentSessionId).toBe('created');
    expect(list.map((s) => s.id)).not.toContain(state.currentSessionId);
    const current = state.sessions.find((s) => s.id === state.currentSessionId);
    expect(current && isBlankNewSession(current)).toBe(true);
  });

  it('(b) a valid remembered chat is restored', async () => {
    localStorage.setItem('neo:last-viewed-session', 'older');
    const { initializeSessionStore, useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    await initializeSessionStore();
    expect(useSessionStore.getState().currentSessionId).toBe('older');
    expect(calls).not.toContain('create');
  });

  it('(c) a remembered chat that no longer exists falls back to the start page', async () => {
    localStorage.setItem('neo:last-viewed-session', 'deleted-long-ago');
    const { initializeSessionStore, useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    await initializeSessionStore();
    expect(useSessionStore.getState().currentSessionId).toBe('created');
  });

  it('(d) an untouched blank session is reused without another create call', async () => {
    list.push(wireSession('blank', '新对话', 0, 5));
    try {
      const { initializeSessionStore, useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
      await initializeSessionStore();
      expect(useSessionStore.getState().currentSessionId).toBe('blank');
      expect(calls).not.toContain('create');
    } finally {
      list.pop();
    }
  });

  it('re-sign-in (auth change) with empty localStorage also opens the start page, not the newest chat', async () => {
    const { initializeSessionStore, reloadSessionsForAuthChange, useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    await initializeSessionStore();
    await reloadSessionsForAuthChange({ principalChanged: true });
    expect(useSessionStore.getState().currentSessionId).toBe('created');
  });

  it('race: auth-change reload empties the store list while boot opens → reuses the server blank session, no create', async () => {
    list.push(wireSession('blank', '新对话', 0, 5));
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let listCalls = 0;
    const base = mockDomainInvoke.getMockImplementation()!;
    mockDomainInvoke.mockImplementation(async (d: string, action: string, payload?: { sessionId?: string }) => {
      // createSession awaits the settings read; the reload's list answers only after that read.
      if (action === 'get') await sleep(40);
      if (action === 'list' && ++listCalls === 2) await sleep(150);
      return base(d, action, payload);
    });
    try {
      const { initializeSessionStore, reloadSessionsForAuthChange, useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
      const init = initializeSessionStore();
      await sleep(15);
      const reload = reloadSessionsForAuthChange({ principalChanged: true });
      await Promise.all([init, reload]);
      expect(useSessionStore.getState().currentSessionId).toBe('blank');
      expect(calls).not.toContain('create');
    } finally {
      list.pop();
    }
  });
});

describe('boot session pick keeps a secondary page the user already opened (F15)', () => {
  const list = [wireSession('busy', '其他任务', 3, 20), wireSession('older', '更早的任务', 2, 10)];

  // The user clicks Automation while boot still waits for the session list (slow start).
  async function bootWithPageOpenedDuringList(openPage: boolean) {
    const { useAppStore } = await import('../../../src/renderer/stores/appStore');
    mockDomainInvoke.mockImplementation(async (_d: string, action: string, payload?: { sessionId?: string }) => {
      if (action === 'list') {
        if (openPage) useAppStore.getState().setShowCronCenter(true);
        return { success: true, data: list };
      }
      if (action === 'load') {
        const found = list.find((s) => s.id === payload?.sessionId);
        return { success: true, data: found ? { ...found, messages: [], todos: [] } : null };
      }
      if (action === 'create') return { success: true, data: { ...wireSession('created', '新对话', 0, 99) } };
      return { success: true, data: [] };
    });
    const { initializeSessionStore, useSessionStore } = await import('../../../src/renderer/stores/sessionStore');
    await initializeSessionStore();
    return { useAppStore, useSessionStore };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
    (globalThis as Record<string, unknown>).window = Object.assign(window, {
      domainAPI: { invoke: mockDomainInvoke },
    });
  });

  it('create branch: Automation stays open and the new blank session is still current', async () => {
    const { useAppStore, useSessionStore } = await bootWithPageOpenedDuringList(true);
    expect(useAppStore.getState().showCronCenter).toBe(true);
    expect(useSessionStore.getState().currentSessionId).toBe('created');
  });

  it('switch branch (remembered chat): Automation stays open and the remembered chat is current', async () => {
    localStorage.setItem('neo:last-viewed-session', 'older');
    const { useAppStore, useSessionStore } = await bootWithPageOpenedDuringList(true);
    expect(useAppStore.getState().showCronCenter).toBe(true);
    expect(useSessionStore.getState().currentSessionId).toBe('older');
  });

  it('switch branch (reused blank session): Automation stays open and the blank session is current', async () => {
    list.push(wireSession('blank', '新对话', 0, 5));
    try {
      const { useAppStore, useSessionStore } = await bootWithPageOpenedDuringList(true);
      expect(useAppStore.getState().showCronCenter).toBe(true);
      expect(useSessionStore.getState().currentSessionId).toBe('blank');
    } finally {
      list.pop();
    }
  });

  it('no secondary page open: boot lands on the chat area as before', async () => {
    const { useAppStore, useSessionStore } = await bootWithPageOpenedDuringList(false);
    expect(useAppStore.getState().showCronCenter).toBe(false);
    expect(useSessionStore.getState().currentSessionId).toBe('created');
  });

  it('after boot, a user switch or new chat still closes the secondary page', async () => {
    const { useAppStore, useSessionStore } = await bootWithPageOpenedDuringList(true);
    await useSessionStore.getState().switchSession('busy');
    expect(useAppStore.getState().showCronCenter).toBe(false);
    useAppStore.getState().setShowCronCenter(true);
    await useSessionStore.getState().createSession('新对话', { workingDirectory: null });
    expect(useAppStore.getState().showCronCenter).toBe(false);
  });

  it('a page-preserving new chat that reuses an existing blank draft keeps the page too', async () => {
    const { useAppStore, useSessionStore } = await bootWithPageOpenedDuringList(false);
    await useSessionStore.getState().switchSession('busy');
    useAppStore.getState().setShowCronCenter(true);
    await useSessionStore.getState().createSession('新对话', { workingDirectory: null, preserveSecondaryPages: true });
    expect(useSessionStore.getState().currentSessionId).toBe('created');
    expect(mockDomainInvoke.mock.calls.filter(([, action]) => action === 'create')).toHaveLength(1);
    expect(useAppStore.getState().showCronCenter).toBe(true);
  });
});
