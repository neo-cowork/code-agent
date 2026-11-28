// @vitest-environment jsdom
// N-FIX-OFFLINE-SEND-DRAFT-ONLY-NO-RESEND:
// Real send path (ChatView -> ChatInput -> useAgentIPC -> real httpTransport), mocking only fetch.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpCodeAgentAPI, createHttpDomainAPI } from '../../../src/renderer/api/httpTransport';
import { ChatView } from '../../../src/renderer/components/ChatView';
import { ProjectComposer } from '../../../src/renderer/components/features/projectSpace/ProjectComposer';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useServerConnectionStore } from '../../../src/renderer/stores/serverConnectionStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { clearFailedSend, mergeFailedSendOutbox } from '../../../src/renderer/stores/failedSendOutbox';
import {
  clearComposerDraftRoundtrip,
  composerDraftStorageKey,
  readComposerDraft,
} from '../../../src/renderer/components/features/chat/ChatInput/composerDraftStore';
import { readOfflinePendingSend } from '../../../src/renderer/components/features/chat/ChatInput/offlinePendingSendStore';

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return {
    Virtuoso: ReactModule.forwardRef(function VirtuosoStub(props: {
      data?: unknown[];
      firstItemIndex?: number;
      itemContent?: (index: number, item: unknown) => React.ReactNode;
    }, ref) {
      ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex() {}, autoscrollToBottom() {} }));
      return (
        <div>
          {(props.data ?? []).map((item, index) => (
            <React.Fragment key={index}>
              {props.itemContent?.((props.firstItemIndex ?? 0) + index, item)}
            </React.Fragment>
          ))}
        </div>
      );
    }),
  };
});

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  constructor(_url: string) {}
}

const initialApp = useAppStore.getState();
const initialAuth = useAuthStore.getState();
const initialSession = useSessionStore.getState();
const initialServer = useServerConnectionStore.getState();
const initialTask = useTaskStore.getState();

type TransportMode = 'online' | 'offline' | 'run-500';
let transportMode: TransportMode = 'online';
let runPayloads: Array<{ prompt?: string; clientMessageId?: string; sessionId?: string }> = [];
let fetchMock: ReturnType<typeof vi.fn>;

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installHttpTransport() {
  window.codeAgentAPI = createHttpCodeAgentAPI('http://localhost:8180');
  window.domainAPI = createHttpDomainAPI('http://localhost:8180');
  window.codeAgentDomainAPI = window.domainAPI;
}

function typeIntoComposer(text: string): HTMLElement {
  const editor = screen.getByTestId('chat-composer-textarea');
  act(() => {
    editor.textContent = text;
    fireEvent.input(editor);
  });
  return editor;
}

function seedBlankProjectSession(sessionId: string) {
  useSessionStore.setState({
    currentSessionId: sessionId,
    messages: [],
    isLoading: false,
    isHydratingSession: false,
    sessions: [{
      id: sessionId,
      title: '新对话',
      projectId: 'proj-1',
      messageCount: 0,
      turnCount: 0,
      createdAt: 1,
      updatedAt: 1,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
    }],
  });
  useTaskStore.setState({ sessionStates: { [sessionId]: { status: 'idle' } } });
}

function seedExistingSession(sessionId: string) {
  useSessionStore.setState({
    currentSessionId: sessionId,
    messages: [
      { id: 'u-prev', role: 'user', content: '上一轮问题', timestamp: 10 },
      { id: 'a-prev', role: 'assistant', content: '上一轮回复', timestamp: 20 },
    ],
    isLoading: false,
    isHydratingSession: false,
    sessions: [{
      id: sessionId,
      title: '已有会话',
      projectId: 'proj-1',
      messageCount: 2,
      turnCount: 1,
      createdAt: 1,
      updatedAt: 20,
      modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
    }],
  });
  useTaskStore.setState({ sessionStates: { [sessionId]: { status: 'idle' } } });
}

describe('Offline send auto-replay (Surface A + Surface B)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    transportMode = 'online';
    runPayloads = [];
    vi.stubGlobal('EventSource', MockEventSource);
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (transportMode === 'offline') {
        throw new TypeError('Failed to fetch');
      }
      if (url.includes('/api/domain/settings/get')) {
        return jsonOk({
          models: {
            default: 'xiaomi',
            providers: {
              xiaomi: { apiKey: 'test-key', enabled: true, model: 'mimo-v2.6-flash' },
            },
          },
        });
      }
      if (url.includes('/api/domain/session/create')) {
        return jsonOk({
          id: 'sess-created-1',
          title: '项目对话',
          projectId: 'proj-space-1',
          createdAt: 1,
          updatedAt: 1,
          modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
        });
      }
      if (url.includes('/api/domain/session/load')) {
        return jsonOk({
          id: 'sess-created-1',
          title: '项目对话',
          messages: [],
          todos: [],
          createdAt: 1,
          updatedAt: 1,
          modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
        });
      }
      if (url.includes('/api/domain/queuedInput/list') || /list/i.test(url)) {
        return jsonOk([]);
      }
      if (url.includes('/api/run')) {
        if (init?.body && typeof init.body === 'string') {
          runPayloads.push(JSON.parse(init.body) as { prompt?: string; clientMessageId?: string; sessionId?: string });
        }
        if (transportMode === 'run-500') {
          return new Response(JSON.stringify({ error: 'Internal failure' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('data: {"type":"agent_complete","data":{}}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (/browser/i.test(url)) {
        return jsonOk({ running: false, sessionId: null });
      }
      if (/rewind/i.test(url)) {
        return jsonOk({ openRewindIds: [] });
      }
      return jsonOk(null);
    });
    vi.stubGlobal('fetch', fetchMock);
    localStorage.clear();
    sessionStorage.clear();
    useAppStore.setState({ ...initialApp, language: 'zh', isProcessing: false, processingSessionIds: new Set(), showSettings: false }, true);
    useAuthStore.setState({ ...initialAuth, isAuthenticated: false, showAuthModal: false }, true);
    useSessionStore.setState({ ...initialSession, sessions: [], currentSessionId: null, messages: [], isLoading: false, isHydratingSession: false }, true);
    useServerConnectionStore.setState({ ...initialServer, status: 'ok', eventStreamRevision: 1 }, true);
    useTaskStore.setState({ ...initialTask, sessionStates: {} }, true);
    installHttpTransport();
  });

  afterEach(() => {
    cleanup();
    clearFailedSend('sess-new-project');
    clearFailedSend('sess-existing');
    clearFailedSend('sess-reconcile');
    clearFailedSend('sess-fail-b');
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('(a) new chat from a project entry: pending strip shown; unmount + remount (reload) + revision bump sends once with original clientMessageId, box empty, no generic draft card', async () => {
    const sessionId = 'sess-new-project';
    const composerKey = composerDraftStorageKey(sessionId, false)!;
    seedBlankProjectSession(sessionId);

    const view = render(<ChatView />);
    await screen.findByTestId('chat-composer-textarea');
    const prompt = '帮我把这周的会议记录整理成三条要点';
    const editor = typeIntoComposer(prompt);

    transportMode = 'offline';
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
    });

    // Offline must NOT open login modal or model settings; pending strip shown, generic draft card suppressed
    const pendingStrip = await screen.findByTestId('offline-pending-send-notice');
    expect(pendingStrip.getAttribute('data-offline-send-state')).toBe('waiting');
    expect(pendingStrip.textContent).toContain('连接恢复后会自动发送');
    expect(screen.getByTestId('offline-send-cancel-auto')).toBeTruthy();
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
    expect(useAuthStore.getState().showAuthModal).toBe(false);
    expect(useAppStore.getState().showSettings).toBe(false);
    expect(useSessionStore.getState().messages.filter((m) => m.role === 'user')).toHaveLength(0);

    const storedPending = readOfflinePendingSend(composerKey);
    expect(storedPending).not.toBeNull();
    const originalId = storedPending!.clientMessageId;
    expect(storedPending!.text).toBe(prompt);

    // Simulate reload: unmount, clear in-memory roundtrip marker, keep localStorage & sessionStorage, remount
    view.unmount();
    clearComposerDraftRoundtrip(composerKey);
    transportMode = 'online';
    render(<ChatView />);

    // Generic draft card stays suppressed before replay
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();

    // Event stream reconnects (revision bump) -> automatic replay with original clientMessageId
    act(() => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });

    await waitFor(() => {
      expect(runPayloads).toHaveLength(1);
    });
    expect(runPayloads[0]?.clientMessageId).toBe(originalId);
    expect(runPayloads[0]?.prompt).toBe(prompt);
    await waitFor(() => {
      expect(screen.getByTestId('chat-composer-textarea').textContent).toBe('');
    });
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
    expect(screen.queryByTestId('offline-pending-send-notice')).toBeNull();
    expect(readOfflinePendingSend(composerKey)).toBeNull();
    expect(readComposerDraft(composerKey)).toBeNull();
  });

  it('(b) existing session: failed bubble + waiting card -> after revision bump one retry with same clientMessageId, no second bubble', async () => {
    const sessionId = 'sess-existing';
    seedExistingSession(sessionId);

    render(<ChatView />);
    await screen.findByTestId('chat-composer-textarea');
    const prompt = '把下半场讨论也补进会议纪要';
    const editor = typeIntoComposer(prompt);

    transportMode = 'offline';
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
    });

    // Existing session (even !isAuthenticated) must NOT open login modal; gets Surface B waiting card
    const waitingCard = await screen.findByTestId('offline-send-card');
    expect(waitingCard.getAttribute('data-offline-card-state')).toBe('waiting');
    expect(waitingCard.textContent).toContain('连接恢复后会自动发送');
    expect(screen.getByTestId('offline-send-retry')).toBeTruthy();
    expect(useAuthStore.getState().showAuthModal).toBe(false);

    const failedUsers = useSessionStore.getState().messages.filter((m) => m.role === 'user');
    expect(failedUsers).toHaveLength(2);
    const originalId = failedUsers[1]!.id;
    expect(failedUsers[1]?.metadata?.sendFailed).toBe(true);
    expect(runPayloads).toHaveLength(0); // fetch threw before reaching body recorder

    // Outbox persisted across reload
    const restoredOutbox = mergeFailedSendOutbox(sessionId, [], []);
    expect(restoredOutbox.some((m) => m.id === originalId && m.metadata?.sendFailed === true)).toBe(true);

    // Recover and bump eventStreamRevision -> one automatic retry with same clientMessageId, no duplicate bubble
    transportMode = 'online';
    act(() => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });

    await waitFor(() => {
      expect(runPayloads).toHaveLength(1);
    });
    expect(runPayloads[0]?.clientMessageId).toBe(originalId);
    expect(runPayloads[0]?.prompt).toBe(prompt);
    await waitFor(() => {
      const users = useSessionStore.getState().messages.filter((m) => m.role === 'user');
      expect(users).toHaveLength(2);
      expect(users[1]?.id).toBe(originalId);
      expect(users[1]?.metadata?.sendFailed).toBeUndefined();
    });
    expect(screen.queryByTestId('offline-send-card')).toBeNull();
  });

  it('(c) clientMessageId already in restored history -> no send (Surface A & Surface B)', async () => {
    const sessionId = 'sess-reconcile';
    const composerKey = composerDraftStorageKey(sessionId, false)!;
    seedBlankProjectSession(sessionId);

    const view = render(<ChatView />);
    await screen.findByTestId('chat-composer-textarea');
    const prompt = '这条其实已经送达了';
    const editor = typeIntoComposer(prompt);

    transportMode = 'offline';
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
    });
    await screen.findByTestId('offline-pending-send-notice');
    const originalId = readOfflinePendingSend(composerKey)!.clientMessageId;

    // Simulate reload where the server DB ALREADY contains that user message id
    view.unmount();
    clearComposerDraftRoundtrip(composerKey);
    transportMode = 'online';
    useSessionStore.setState({
      messages: [
        { id: originalId, role: 'user', content: prompt, timestamp: 100 },
        { id: 'a-confirmed', role: 'assistant', content: '已收到', timestamp: 101 },
      ],
    });
    render(<ChatView />);
    act(() => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });

    await waitFor(() => {
      expect(readOfflinePendingSend(composerKey)).toBeNull();
    });
    expect(runPayloads).toHaveLength(0);
    expect(screen.queryByTestId('offline-pending-send-notice')).toBeNull();
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();

    // Surface B: stale offline error card whose clientMessageId is already confirmed in restored history -> no send
    const bSessionId = 'sess-existing';
    useSessionStore.setState({
      currentSessionId: bSessionId,
      messages: [
        { id: 'u-prev', role: 'user', content: '上一轮问题', timestamp: 10 },
        { id: 'u-confirmed-b', role: 'user', content: '已落库的用户消息', timestamp: 20 },
        {
          id: 'err-stale-b',
          role: 'assistant',
          content: '',
          timestamp: 21,
          metadata: {
            retryPrompt: '已落库的用户消息',
            retryClientMessageId: 'u-confirmed-b',
            retrySessionId: bSessionId,
            sendFailureCode: 'SEND_OFFLINE_PENDING',
          },
        },
      ],
      sessions: [{
        id: bSessionId,
        title: '已有会话',
        projectId: 'proj-1',
        messageCount: 2,
        turnCount: 2,
        createdAt: 1,
        updatedAt: 21,
        modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
      }],
    });
    act(() => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });
    await waitFor(() => {
      expect(useSessionStore.getState().messages.some((m) => m.id === 'err-stale-b')).toBe(false);
    });
    expect(runPayloads).toHaveLength(0);
  });

  it('(d) text edited while pending (and cancel button) -> no auto-send on revision bump', async () => {
    const sessionId = 'sess-new-project';
    const composerKey = composerDraftStorageKey(sessionId, false)!;
    seedBlankProjectSession(sessionId);

    render(<ChatView />);
    await screen.findByTestId('chat-composer-textarea');
    const editor = typeIntoComposer('原始内容');

    transportMode = 'offline';
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
    });
    await screen.findByTestId('offline-pending-send-notice');
    expect(readOfflinePendingSend(composerKey)).not.toBeNull();

    // Edit text while pending -> cancels auto-send immediately
    typeIntoComposer('用户修改后的内容');
    await waitFor(() => {
      expect(screen.queryByTestId('offline-pending-send-notice')).toBeNull();
    });
    expect(readOfflinePendingSend(composerKey)).toBeNull();

    transportMode = 'online';
    act(() => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(runPayloads).toHaveLength(0);
    expect(screen.getByTestId('chat-composer-textarea').textContent).toBe('用户修改后的内容');
  });

  it('(e1) Surface A replay fails -> text stays in box with distinct still-not-sent notice, no second auto-send', async () => {
    const sessionId = 'sess-new-project';
    const composerKey = composerDraftStorageKey(sessionId, false)!;
    seedBlankProjectSession(sessionId);

    const view = render(<ChatView />);
    await screen.findByTestId('chat-composer-textarea');
    const prompt = '重放时会遇到服务端报错的消息';
    const editor = typeIntoComposer(prompt);

    transportMode = 'offline';
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
    });
    await screen.findByTestId('offline-pending-send-notice');

    // Reload, server reachable for settings/get, but /api/run fails with 500
    view.unmount();
    clearComposerDraftRoundtrip(composerKey);
    transportMode = 'run-500';
    render(<ChatView />);
    act(() => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });

    await waitFor(() => {
      const strip = screen.getByTestId('offline-pending-send-notice');
      expect(strip.getAttribute('data-offline-send-state')).toBe('replay_failed');
      expect(strip.textContent).toContain('点发送再试一次');
    });
    expect(screen.getByTestId('chat-composer-textarea').textContent).toBe(prompt);
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
    expect(readOfflinePendingSend(composerKey)).toBeNull();
    expect(runPayloads).toHaveLength(1);

    // Another revision bump must NOT auto-send again
    act(() => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(runPayloads).toHaveLength(1);
  });

  it('(e2) Surface B replay fails -> card transitions to normal retry state, no second auto-send', async () => {
    const sessionId = 'sess-fail-b';
    seedExistingSession(sessionId);

    render(<ChatView />);
    await screen.findByTestId('chat-composer-textarea');
    const prompt = '已有会话重放失败的消息';
    const editor = typeIntoComposer(prompt);

    transportMode = 'offline';
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
    });
    const waitingCard = await screen.findByTestId('offline-send-card');
    expect(waitingCard.getAttribute('data-offline-card-state')).toBe('waiting');

    // Replay hits 500 -> transitions to normal retry state ('failed')
    transportMode = 'run-500';
    act(() => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });

    await waitFor(() => {
      const card = screen.getByTestId('offline-send-card');
      expect(card.getAttribute('data-offline-card-state')).toBe('failed');
      expect(card.textContent).toContain('请重试');
      expect(card.textContent).not.toContain('会自动发送');
    });
    expect(screen.getByTestId('offline-send-retry')).toBeTruthy();
    expect(runPayloads).toHaveLength(1);

    // Another revision bump must NOT auto-retry again
    act(() => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(runPayloads).toHaveLength(1);
  });

  it('Surface B stale outbox entry from a closed/reopened app (no sessionStorage ticket) degrades to manual retry without auto-sending', async () => {
    const sessionId = 'sess-existing';
    useSessionStore.setState({
      currentSessionId: sessionId,
      messages: [
        { id: 'u-prev', role: 'user', content: '上一轮问题', timestamp: 10 },
        { id: 'u-stale-old', role: 'user', content: '三天前离线失败的旧指令', timestamp: 20, metadata: { sendFailed: true } },
        {
          id: 'err-stale-old',
          role: 'assistant',
          content: '',
          timestamp: 21,
          metadata: {
            retryPrompt: '三天前离线失败的旧指令',
            retryClientMessageId: 'u-stale-old',
            retrySessionId: sessionId,
            sendFailureCode: 'SEND_OFFLINE_PENDING',
          },
        },
      ],
      sessions: [{
        id: sessionId,
        title: '已有会话',
        projectId: 'proj-1',
        messageCount: 2,
        turnCount: 2,
        createdAt: 1,
        updatedAt: 21,
        modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
      }],
    });
    // sessionStorage is empty (simulates closing and reopening Neo in a new browser session)
    sessionStorage.clear();

    render(<ChatView />);
    act(() => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });

    await waitFor(() => {
      const card = screen.getByTestId('offline-send-card');
      expect(card.getAttribute('data-offline-card-state')).toBe('failed');
    });
    expect(runPayloads).toHaveLength(0);
  });

  it('ProjectComposer offline failure shows Surface A waiting strip and cancel button stops auto-send (en copy checked)', async () => {
    useAppStore.setState({ language: 'en' });
    render(
      <ProjectComposer
        project={{
          id: 'proj-space-1',
          name: 'Test Project',
          workspacePath: '/tmp/proj',
          createdAt: 1,
          updatedAt: 1,
        } as never}
      />,
    );
    await screen.findByTestId('chat-composer-textarea');
    const editor = typeIntoComposer('Summarise this week project notes');

    transportMode = 'offline';
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
    });

    const strip = await screen.findByTestId('offline-pending-send-notice');
    expect(strip.getAttribute('data-offline-send-state')).toBe('waiting');
    expect(strip.textContent).toContain('will be sent automatically');
    fireEvent.click(screen.getByTestId('offline-send-cancel-auto'));
    await waitFor(() => {
      expect(screen.queryByTestId('offline-pending-send-notice')).toBeNull();
    });
    expect(screen.getByTestId('chat-composer-textarea').textContent).toBe('Summarise this week project notes');
  });

  it('Surface A with attachments while offline: no auto-send, distinct attachments_not_sent notice', async () => {
    const sessionId = 'sess-new-project';
    const composerKey = composerDraftStorageKey(sessionId, false)!;
    seedBlankProjectSession(sessionId);

    const view = render(<ChatView />);
    await screen.findByTestId('chat-composer-textarea');
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeTruthy();
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    await act(async () => {
      Object.defineProperty(fileInput!, 'files', { value: [file], configurable: true });
      fireEvent.change(fileInput!);
    });
    await waitFor(() => {
      expect(view.container.textContent).toContain('notes.txt');
    });
    const editor = typeIntoComposer('请整理附件内容');

    transportMode = 'offline';
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
    });

    const strip = await screen.findByTestId('offline-pending-send-notice');
    expect(strip.getAttribute('data-offline-send-state')).toBe('attachments_not_sent');
    expect(strip.textContent).toContain('带附件');
    expect(readOfflinePendingSend(composerKey)).toBeNull();

    transportMode = 'online';
    act(() => {
      useServerConnectionStore.getState().markEventStreamConnected();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(runPayloads).toHaveLength(0);
  });
});
