import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { executeLoadSessions } from '../../../src/renderer/stores/sessionListPagination';
import { useSessionStore, type CreateSessionOptions, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useSessionUIStore } from '../../../src/renderer/stores/sessionUIStore';

vi.mock('../../../src/renderer/stores/sessionStore', async () => {
  const { create } = await import('zustand');
  return {
    useSessionStore: create<{
      sessions: SessionWithMeta[];
      currentSessionId: string | null;
      switchSession: (id: string) => Promise<void>;
      createSession: (title?: string, options?: CreateSessionOptions) => Promise<SessionWithMeta | null>;
    }>((set) => ({
      sessions: [],
      currentSessionId: null,
      switchSession: vi.fn(async (id: string) => { set({ currentSessionId: id }); }),
      createSession: vi.fn(async (title?: string, options?: CreateSessionOptions) => {
        const draft = {
          ...session('draft', 0),
          projectId: options?.projectId,
          workingDirectory: options?.workingDirectory ?? undefined,
          title: title ?? '',
        };
        set((state) => ({
          sessions: [draft, ...state.sessions],
          currentSessionId: draft.id,
        }));
        return draft;
      }),
    })),
  };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      language: 'en',
      syncActiveAgentForSession: vi.fn(),
      syncWorkbenchForSession: vi.fn(),
    }),
  },
}));

const projectId = 'reading-club';
const workingDirectory = '/projects/reading-club';

function session(id: string, updatedAt: number, project = projectId): SessionWithMeta {
  return {
    id,
    title: id,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    projectId: project,
    workingDirectory,
    type: 'chat',
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
    turnCount: 0,
  };
}

function expectLanding(id: string): void {
  const state = useSessionStore.getState();
  expect(state.currentSessionId).toBe(id);
  expect(state.sessions.find((row) => row.id === state.currentSessionId)?.projectId).toBe(projectId);
}

describe('sessionUIStore.softDelete project landing', () => {
  const otherProject = session('other-project', 5, 'holidays');
  const newest = session('newest', 4);
  const previous = session('previous', 3);
  const current = session('current', 2);
  const next = session('next', 1);
  const oldest = session('oldest', 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useSessionUIStore.setState({ pendingDelete: null });
  });

  it.each([
    { deleted: current, expected: next },
    { deleted: oldest, expected: next },
  ])('lands on the next row or the nearest previous row ($deleted.id)', ({ deleted, expected }) => {
    useSessionStore.setState({
      sessions: [otherProject, oldest, newest, next, previous, current],
      currentSessionId: deleted.id,
    });

    useSessionUIStore.getState().softDelete([deleted.id]);

    expectLanding(expected.id);
    expect(useSessionStore.getState().createSession).not.toHaveBeenCalled();
  });

  it('opens a blank session in the same project when its last session is deleted', () => {
    const app = useAppStore.getState();
    const getAppState = vi.spyOn(useAppStore, 'getState').mockReturnValueOnce(app);
    useSessionStore.setState({ sessions: [otherProject, current], currentSessionId: current.id });

    useSessionUIStore.getState().softDelete([current.id]);
    getAppState.mockRestore();

    const state = useSessionStore.getState();
    expect(state.createSession).toHaveBeenCalledWith('New conversation', { workingDirectory, projectId });
    expect(state.switchSession).not.toHaveBeenCalled();
    expect(app.syncActiveAgentForSession).toHaveBeenCalledWith(null);
    expect(app.syncWorkbenchForSession).toHaveBeenCalledWith(null);
    expectLanding('draft');
  });

  it('skips every deleted ID and uses the open row as the anchor in a batch', () => {
    useSessionStore.setState({
      sessions: [otherProject, newest, previous, current, next, oldest],
      currentSessionId: current.id,
    });

    useSessionUIStore.getState().softDelete([newest.id, next.id, current.id]);

    expectLanding(oldest.id);
    expect(useSessionStore.getState().sessions.map((row) => row.id)).toEqual([otherProject.id, previous.id, oldest.id]);
  });

  it('keeps a pending row hidden when creating the replacement refreshes the list', async () => {
    useSessionStore.setState({ sessions: [otherProject, current], currentSessionId: current.id });
    useSessionUIStore.getState().softDelete([current.id]);
    const draft = useSessionStore.getState().sessions.find((row) => row.id === 'draft');
    vi.stubGlobal('window', {
      domainAPI: { invoke: vi.fn().mockResolvedValue({ success: true, data: [draft, otherProject, current] }) },
    });

    await executeLoadSessions({ get: useSessionStore.getState, set: useSessionStore.setState }, { silent: true });

    expect(useSessionStore.getState().sessions.map((row) => row.id)).toEqual(['draft', otherProject.id]);
    expectLanding('draft');
  });

  it('restores the original batch when replacement creation fails after the timer expires', async () => {
    const app = useAppStore.getState();
    const getAppState = vi.spyOn(useAppStore, 'getState').mockReturnValue(app);
    let failReplacement!: (value: null) => void;
    const failure = new Promise<null>((resolve) => { failReplacement = resolve; });
    const invoke = vi.fn();
    vi.stubGlobal('window', { domainAPI: { invoke } });
    useSessionStore.setState({ sessions: [otherProject, previous, current], currentSessionId: current.id });
    vi.mocked(useSessionStore.getState().createSession).mockReturnValueOnce(failure);

    useSessionUIStore.getState().softDelete([previous.id, current.id]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(useSessionStore.getState().sessions).toEqual([otherProject]);
    expect(invoke).not.toHaveBeenCalled();

    failReplacement(null);
    await useSessionUIStore.getState().pendingDelete?.replacement;
    expect(useSessionStore.getState().sessions).toEqual([otherProject, previous, current]);
    expect(useSessionStore.getState().switchSession).not.toHaveBeenCalled();
    expect(app.syncActiveAgentForSession).toHaveBeenLastCalledWith(current.id, { metadata: current.metadata });
    expect(app.syncWorkbenchForSession).toHaveBeenLastCalledWith(current.id);
    expect(useSessionUIStore.getState().pendingDelete).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expectLanding(current.id);
    getAppState.mockRestore();
  });
});
