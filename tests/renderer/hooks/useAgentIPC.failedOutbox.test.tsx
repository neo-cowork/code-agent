// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessageAttachment } from '../../../src/shared/contract';
import { useAgentIPC } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke, invokeDomain: vi.fn().mockResolvedValue({ outcome: 'steered' }) },
}));

const sessionId = 'outbox-meeting';
const key = 'neo-failed-send-outbox:' + sessionId;
const attachment: MessageAttachment = {
  id: 'notes-attachment', type: 'file', category: 'text', name: 'notes.md', size: 27,
  mimeType: 'text/markdown', data: '# Meeting\nReview on Friday.', path: './workspace/uploads/notes.md',
};
let dbMessages: Message[];
const domainInvoke = vi.fn(async (_domain: string, action: string, payload?: { sessionId?: string }) => ({
  success: true,
  data: action === 'load' ? {
    id: payload?.sessionId, title: 'Meeting notes', createdAt: 1, updatedAt: 2,
    status: 'idle', messages: payload?.sessionId === sessionId ? dbMessages : [],
  } : [],
}));

function sender() {
  return renderHook(() => useAgentIPC({
    currentSessionId: sessionId, addMessage: useSessionStore.getState().addMessage,
    currentTurnMessageIdRef: { current: null }, isProcessing: false,
    setIsProcessing: vi.fn(), setSessionProcessing: useAppStore.getState().setSessionProcessing,
  }));
}

async function fail(attachments?: MessageAttachment[], clientMessageId = 'original-client-id', trust = false) {
  invoke.mockRejectedValueOnce(trust
    ? Object.assign(new Error('Project folder needs confirmation'), { status: 422, code: 'PROJECT_SOURCE_TRUST' })
    : new Error('HTTP 500: Internal Server Error'));
  const hook = sender();
  await act(async () => {
    expect(await hook.result.current.sendMessage({
      content: 'Summarize this file into 3 bullet points', sessionId,
      clientMessageId, attachments,
    })).toEqual({ outcome: 'failed' });
  });
  return hook;
}

async function returnToSession(force = false) {
  await act(async () => {
    if (!force) await useSessionStore.getState().switchSession('other-meeting');
    await useSessionStore.getState().switchSession(sessionId, { force });
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  window.domainAPI = { invoke: domainInvoke } as unknown as typeof window.domainAPI;
  await useSessionStore.getState().deleteSession(sessionId);
  dbMessages = [];
  invoke.mockReset();
  useSessionStore.setState({ currentSessionId: sessionId, sessions: [], messages: [] });
  useAppStore.setState({ isProcessing: false, processingSessionIds: new Set() });
  useTaskStore.setState({ sessionStates: {} });
  useSwarmStore.getState().reset();
});
afterEach(() => { vi.restoreAllMocks(); useMessageActionStore.getState().unregister(); });

describe('failed send outbox through sendMessage and switchSession', () => {
  it.each([false, true])('keeps both blocked turns in send order after switch and module reload (attachment=%s)', async (withAttachment) => {
    await fail(undefined, 'blocked-A', true);
    await fail(withAttachment ? [attachment] : undefined, 'blocked-B', true);
    const expected = useSessionStore.getState().messages;
    const order = expected.map((message) => message.id);
    expect(order[0]).toBe('blocked-A');
    expect(order[2]).toBe('blocked-B');
    await returnToSession();
    console.log('switch order:', useSessionStore.getState().messages.map((message) => message.id));
    expect(useSessionStore.getState().messages.map((message) => message.id)).toEqual(order);
    expect(useSessionStore.getState().messages).toEqual(expected);
    vi.resetModules();
    const { useSessionStore: reloaded } = await import('../../../src/renderer/stores/sessionStore');
    await reloaded.getState().switchSession(sessionId);
    console.log('reload order:', reloaded.getState().messages.map((message) => message.id));
    expect(reloaded.getState().messages.map((message) => message.id)).toEqual(order);
    expect(reloaded.getState().messages.filter((message) => message.metadata?.sendFailureCode === 'PROJECT_SOURCE_TRUST')).toHaveLength(2);
    if (withAttachment) expect(reloaded.getState().messages[2].attachments?.[0].name).toBe('notes.md');
  });

  it('places restored pairs between loaded history by timestamp and prunes only the DB-owned turn', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    await fail(undefined, 'blocked-A', true);
    vi.spyOn(Date, 'now').mockReturnValue(300);
    await fail([attachment], 'blocked-B', true);
    const failed = useSessionStore.getState().messages;
    dbMessages = [
      { id: 'before', role: 'assistant', content: 'Earlier notes', timestamp: 50 },
      { id: 'between', role: 'assistant', content: 'Saved notes', timestamp: 200 },
      { id: 'after', role: 'assistant', content: 'Later notes', timestamp: 400 },
    ];
    await returnToSession();
    expect(useSessionStore.getState().messages.map((message) => message.id)).toEqual([
      'before', failed[0].id, failed[1].id, 'between', failed[2].id, failed[3].id, 'after',
    ]);
    dbMessages = [{ ...failed[0], metadata: undefined }];
    await returnToSession(true);
    expect(useSessionStore.getState().messages.filter((message) => message.id === 'blocked-A')).toEqual(dbMessages);
    expect(useSessionStore.getState().messages.some((message) => message.id === failed[1].id)).toBe(false);
    expect(JSON.parse(localStorage.getItem(key)!).map((entry: { user: Message }) => entry.user.id)).toEqual(['blocked-B']);
    vi.resetModules();
    const { useSessionStore: reloaded } = await import('../../../src/renderer/stores/sessionStore');
    await reloaded.getState().switchSession(sessionId);
    expect(reloaded.getState().messages.map((message) => message.id)).toEqual(['blocked-A', failed[2].id, failed[3].id]);
  });

  it('loads the legacy single-object value after module reload', async () => {
    await fail([attachment]);
    const stored = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify(Array.isArray(stored) ? stored[0] : stored));
    const expected = useSessionStore.getState().messages;
    vi.resetModules();
    const { useSessionStore: reloaded } = await import('../../../src/renderer/stores/sessionStore');
    await reloaded.getState().switchSession(sessionId);
    expect(reloaded.getState().messages).toEqual(expected);
    expect(reloaded.getState().messages[0].attachments?.[0].name).toBe('notes.md');
  });

  it.each([['Markdown attachment', [attachment]], ['text only', undefined]] as const)(
    'restores %s and its error/retry anchor after switching away and back', async (_variant, attachments) => {
      await fail(attachments ? [...attachments] : undefined);
      const failed = useSessionStore.getState().messages;
      const stored = JSON.parse(localStorage.getItem(key)!);
      expect((Array.isArray(stored) ? stored[0] : stored).user.attachments).toEqual(attachments);
      await returnToSession();
      expect(useSessionStore.getState().messages).toEqual(failed);
      expect(useSessionStore.getState().messages[0].metadata?.sendFailed).toBe(true);
      expect(useSessionStore.getState().messages[1].metadata).toMatchObject({
        retryClientMessageId: 'original-client-id', retrySessionId: sessionId,
        ...(attachments ? { retryAttachments: attachments } : {}),
      });
    },
  );

  it('hydrates serialized storage without a memory cache and force reload stays unique', async () => {
    await fail([attachment]);
    const serialized = localStorage.getItem(key)!;
    const expected = useSessionStore.getState().messages;
    // Delete through the real store to clear the memory cache, then restore disk only.
    await useSessionStore.getState().deleteSession(sessionId);
    localStorage.setItem(key, serialized);
    useSessionStore.setState({ currentSessionId: null, messages: [] });
    await returnToSession();
    expect(useSessionStore.getState().messages).toEqual(expected);
    await returnToSession(true);
    expect(useSessionStore.getState().messages).toEqual(expected);
  });

  it('restores composer text/file/client ID and clears only after that resend is accepted', async () => {
    const hook = await fail([attachment]);
    await returnToSession();
    const restore = vi.fn();
    useMessageActionStore.getState().register(vi.fn(), () => useSessionStore.getState().messages, restore);
    useMessageActionStore.getState().editAndResendMessage('original-client-id');
    expect(restore).toHaveBeenCalledWith({
      content: 'Summarize this file into 3 bullet points', attachments: [attachment], clientMessageId: 'original-client-id',
    });
    let accept!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { accept = resolve; }));
    let retry!: Promise<unknown>;
    await act(async () => {
      retry = hook.result.current.sendMessage({ ...restore.mock.calls[0][0], sessionId });
      await Promise.resolve();
    });
    expect(localStorage.getItem(key)).not.toBeNull();
    await act(async () => { accept(); await retry; });
    expect(localStorage.getItem(key)).toBeNull();
    dbMessages = [{ id: 'original-client-id', role: 'user', content: 'Persisted reply task', timestamp: 3, attachments: [attachment] }];
    await returnToSession();
    expect(useSessionStore.getState().messages).toEqual(dbMessages);
  });

  it('DB wins over optimistic copy on force reload and removes its local error card', async () => {
    await fail([attachment]);
    dbMessages = [{ id: 'original-client-id', role: 'user', content: 'Accepted on host', timestamp: 4 }];
    await returnToSession(true);
    expect(useSessionStore.getState().messages).toEqual(dbMessages);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('accepting a different client ID keeps the failed turn; session deletion removes it', async () => {
    const hook = await fail();
    invoke.mockResolvedValueOnce(undefined);
    await act(async () => {
      await hook.result.current.sendMessage({ sessionId, clientMessageId: 'another-id', content: 'Another request' });
    });
    expect(localStorage.getItem(key)).not.toBeNull();
    await useSessionStore.getState().deleteSession(sessionId);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('a failed edited resend keeps the newer text even when quota leaves an older disk entry', async () => {
    const hook = await fail([attachment]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    invoke.mockRejectedValueOnce(new Error('HTTP 500'));
    await act(async () => {
      await hook.result.current.sendMessage({ sessionId, clientMessageId: 'original-client-id', content: 'Revised request', attachments: [attachment] });
    });
    await returnToSession();
    expect(useSessionStore.getState().messages).toHaveLength(2);
    expect(useSessionStore.getState().messages[0].content).toBe('Revised request');
    expect(useSessionStore.getState().messages[1].metadata?.retryPrompt).toBe('Revised request');
  });

  it('storage read failure logs storage unavailable while leaving the DB history usable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    dbMessages = [{ id: 'stored', role: 'assistant', content: 'Meeting summary', timestamp: 4 }];
    await returnToSession();
    expect(useSessionStore.getState().messages).toEqual(dbMessages);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[FailedSendOutbox]'), { reason: 'storage unavailable' });
  });

  it.each(['QuotaExceededError', 'SecurityError'])(
    'keeps switch recovery fail-open and warns with distinct reason for %s', async (name) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', name); });
      await fail([attachment]);
      await returnToSession();
      expect(useSessionStore.getState().messages[0].attachments).toEqual([attachment]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[FailedSendOutbox]'), {
        reason: name === 'QuotaExceededError' ? 'quota exceeded' : 'storage unavailable',
      });
    },
  );

  it.each([['invalid JSON', '{', 'unparsable entry'], ['wrong session', JSON.stringify({ sessionId: 'other' }), 'session mismatch']])(
    'rejects %s without polluting the target session and logs its reason', async (_name, raw, reason) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      localStorage.setItem(key, raw);
      await returnToSession();
      expect(useSessionStore.getState().messages).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[FailedSendOutbox]'), { reason });
    },
  );
});
