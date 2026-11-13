import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { useSessionStore, findReusableNewSessionDraft, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';

const invoke = vi.fn();
const directory = '/tmp/project-draft-regression';
const hostMessages = new Map<string, Message[]>();
const blank = (id: string, workingDirectory: string | null = directory): SessionWithMeta => ({
  id, title: '新对话', workingDirectory,
  modelConfig: { provider: 'openai', model: 'gpt-5' },
  createdAt: 1, updatedAt: 1, messageCount: 0, turnCount: 0,
});
const user: Message = { id: 'marked-user', role: 'user', content: 'Summarize notes.txt into three key points.', timestamp: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  hostMessages.clear();
  useSessionStore.setState({ sessions: [], currentSessionId: null, messages: [] });
  (globalThis as Record<string, unknown>).window = { domainAPI: { invoke } };
  invoke.mockImplementation(async (_domain: string, action: string, payload?: { sessionId?: string; workingDirectory?: string | null }) => {
    if (action === 'create') return { success: true, data: blank('fresh', payload?.workingDirectory) };
    if (action === 'getMessages') return { success: true, data: hostMessages.get(payload?.sessionId ?? '') ?? [] };
    if (action === 'load') return { success: true, data: { ...blank(payload?.sessionId ?? ''), ...(payload?.sessionId === 'away' ? { title: 'Previous work' } : {}), messages: hostMessages.get(payload?.sessionId ?? '') ?? [] } };
    if (action === 'list') return { success: true, data: [blank('used')] };
    return { success: true, data: null };
  });
  useSessionStore.setState({ sessions: [blank('used')], currentSessionId: 'used', messages: [], todos: [],
    runningSessionIds: new Set(), sessionRuntimes: new Map(), pendingUserQuestionsBySessionId: new Map(),
    isLoading: false, isHydratingSession: false, isCreatingSession: false });
  useAppStore.setState({ processingSessionIds: new Set(), pendingPermissionRequest: null,
    pendingPermissionSessionId: null, queuedPermissionRequests: {}, workingDirectory: directory });
  useTaskStore.setState({ sessionStates: {} });
  useComposerStore.getState().activateScope('session:used');
});

function logCandidate(sequence: string, workingDirectory: string | null = directory) {
  const s = useSessionStore.getState();
  const hit = findReusableNewSessionDraft({ ...s, workingDirectory });
  const meta = s.sessions.find((row) => row.id === 'used');
  console.log(JSON.stringify({ sequence, messageCount: meta?.messageCount, turnCount: meta?.turnCount,
    hostRealCount: hostMessages.get('used')?.length ?? 0, locallyLoaded: s.messages.length,
    findReusableNewSessionDraft: hit?.id ?? null }));
}

async function expectFresh(workingDirectory: string | null = directory) {
  const result = await useSessionStore.getState().createSession('新对话', { workingDirectory });
  expect(result?.id).toBe('fresh');
  expect(useSessionStore.getState().currentSessionId).toBe('fresh');
  expect(useSessionStore.getState().messages).toEqual([]);
}

describe('project new-session uses actual messages, through createSession', () => {
  it.each(['text', 'attachment', 'silent-list-then-switch', 'switch-immediately'])(
    'first send sequence: %s never reuses a used placeholder', async (sequence) => {
      const message = sequence === 'attachment' ? { ...user, content: '', attachments: [
        { id: 'notes', type: 'file' as const, name: 'notes.txt', path: '/tmp/notes.txt' },
      ] } : user;
      useSessionStore.getState().addMessage(message);
      hostMessages.set('used', [message]);
      if (sequence === 'silent-list-then-switch') await useSessionStore.getState().loadSessions({ silent: true });
      if (sequence.includes('switch')) await useSessionStore.getState().switchSession('away');
      logCandidate(sequence);
      await expectFresh();
    },
  );

  it.each(['sidebar', 'project-title', 'project-drawer'])(
    '%s rejects host-side user messages despite zero list counts', async (entry) => {
      const wd = entry === 'sidebar' ? null : directory;
      useSessionStore.setState({ sessions: [blank('used', wd)], currentSessionId: 'away', messages: [] });
      hostMessages.set('used', [user]);
      logCandidate(entry, wd);
      await expectFresh(wd);
    },
  );

  it('remembers a locally sent attachment after switching and a stale zero host/list read', async () => {
    useSessionStore.getState().addMessage({ ...user, content: '', attachments: [
      { id: 'notes', type: 'file', name: 'notes.txt' },
    ] });
    await useSessionStore.getState().loadSessions({ silent: true });
    await useSessionStore.getState().switchSession('away');
    await expectFresh();
    expect(hostMessages.get('used')).toBeUndefined();
  });

  it.each(['message', 'running', 'permission'])('rejects a candidate becoming used during the host read: %s', async (signal) => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (...args: Parameters<typeof original>) => {
      if (args[1] === 'getMessages') {
        if (signal === 'message') useSessionStore.getState().addMessage(user);
        if (signal === 'running') useSessionStore.setState({ runningSessionIds: new Set(['used']) });
        if (signal === 'permission') useAppStore.setState({ pendingPermissionSessionId: 'used', pendingPermissionRequest: { id: 'approval' } as never });
        return { success: true, data: [] };
      }
      return original(...args);
    });
    await expectFresh();
  });

  it('rejects a user message first revealed by switch hydration after a zero host read', async () => {
    useSessionStore.setState({ currentSessionId: 'away' });
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (...args: Parameters<typeof original>) => {
      if (args[1] === 'load') return { success: true, data: { ...blank('used'), messages: [user] } };
      return original(...args);
    });
    await expectFresh();
  });

  it.each(['error', 'malformed'])('creates fresh when host verification is %s', async (failure) => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (...args: Parameters<typeof original>) => {
      if (args[1] === 'getMessages') return failure === 'error'
        ? { success: false, error: { message: 'host unavailable' } }
        : { success: true, data: null };
      return original(...args);
    });
    await expectFresh();
  });

  it('continues past a used host candidate to reuse a genuinely empty draft', async () => {
    useSessionStore.setState({ currentSessionId: 'away', sessions: [blank('used'), blank('empty')] });
    hostMessages.set('used', [user]);
    const result = await useSessionStore.getState().createSession('新对话', { workingDirectory: directory });
    expect(result?.id).toBe('empty');
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(invoke.mock.calls.filter(([, action]) => action === 'create')).toHaveLength(0);
  });

  it('reuses a genuinely empty project draft repeatedly without creating more sessions', async () => {
    useSessionStore.setState({ currentSessionId: 'away' });
    for (let i = 0; i < 3; i++) {
      const result = await useSessionStore.getState().createSession('新对话', { workingDirectory: directory });
      expect(result?.id).toBe('used');
      expect(useSessionStore.getState().messages).toEqual([]);
    }
    expect(invoke.mock.calls.filter(([, action]) => action === 'create')).toHaveLength(0);
  });
});
