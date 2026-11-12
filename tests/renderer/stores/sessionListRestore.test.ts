// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore, reloadSessionsForAuthChange } from '../../../src/renderer/stores/sessionStore';
import { resetSessionListLoadState, useSessionListLoadStore } from '../../../src/renderer/stores/sessionListPagination';
import { SESSION_LIST_PAGE_SIZE } from '../../../src/shared/constants';
import { useSessionLoadRecoveryStore } from '../../../src/renderer/stores/sessionLoadRecovery';

const invoke = vi.fn();
const session = { id: 'restore-1', title: 'Weekly report', createdAt: 1, updatedAt: 2, modelConfig: {} };

beforeEach(() => {
  vi.clearAllMocks();
  window.domainAPI = { invoke } as unknown as typeof window.domainAPI;
  useSessionStore.setState({ sessions: [], currentSessionId: null, messages: [], error: null, isLoading: false, isHydratingSession: false });
  resetSessionListLoadState();
  useSessionLoadRecoveryStore.setState({ sessionId: null, errorCode: null });
});

describe('restored sidebar list readiness', () => {
  it('starts unsettled and publishes complete rows only when list resolves', async () => {
    let finish!: (value: unknown) => void;
    invoke.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    expect(useSessionListLoadStore.getState()).toMatchObject({ settled: false, loading: false });
    const pending = useSessionStore.getState().loadSessions();
    expect(useSessionListLoadStore.getState()).toMatchObject({ settled: false, loading: true });
    finish({ success: true, data: [session] });
    await pending;
    expect(useSessionListLoadStore.getState()).toMatchObject({ settled: true, loading: false, error: false });
    expect(useSessionStore.getState().sessions.map((row) => row.id)).toEqual([session.id]);
  });

  it('keeps silent confirmation stable and settles a failure with its reload code', async () => {
    invoke.mockResolvedValueOnce({ success: true, data: [session] });
    await useSessionStore.getState().loadSessions();
    let finish!: (value: unknown) => void;
    invoke.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = useSessionStore.getState().loadSessions({ silent: true });
    expect(useSessionListLoadStore.getState()).toMatchObject({ settled: true, loading: false });
    finish({ success: false, error: { code: 'LOCAL_AUTH_TOKEN_EXPIRED', message: 'private transport diagnostic' } });
    await pending;
    expect(useSessionListLoadStore.getState()).toMatchObject({ settled: true, loading: false, error: true, errorCode: 'LOCAL_AUTH_TOKEN_EXPIRED' });
    invoke.mockResolvedValue({ success: true, data: [session] });
    await useSessionStore.getState().loadSessions();
    expect(useSessionListLoadStore.getState()).toMatchObject({ error: false, errorCode: null });
  });

  it('discards an old principal response after resetting list readiness', async () => {
    let finish!: (value: unknown) => void;
    invoke.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = useSessionStore.getState().loadSessions();
    await reloadSessionsForAuthChange({ principalChanged: true });
    finish({ success: true, data: [session] });
    await pending;
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useSessionListLoadStore.getState()).toMatchObject({ settled: false });
  });

  it('opened session failure ends hydration and retains an actionable recovery code', async () => {
    invoke.mockImplementation(async (_domain, action) => action === 'load'
      ? { success: false, error: { code: 'LOCAL_AUTH_TOKEN_EXPIRED', message: 'private diagnostic' } }
      : { success: true, data: [] });
    await useSessionStore.getState().switchSession(session.id);
    expect(useSessionStore.getState()).toMatchObject({ currentSessionId: session.id, isHydratingSession: false, isLoading: false });
    expect(useSessionLoadRecoveryStore.getState()).toMatchObject({ sessionId: session.id, errorCode: 'LOCAL_AUTH_TOKEN_EXPIRED' });
  });
});


describe('superseded session-list loading ownership', () => {
  it.each([
    ['success', 'stale-first', false], ['error', 'stale-first', false],
    ['success', 'latest-first', false], ['error', 'latest-first', false],
    ['success', 'stale-first', true], ['error', 'stale-first', true],
    ['success', 'latest-first', true], ['error', 'latest-first', true],
  ] as const)('settles a foreground read superseded by a no-op silent read: stale=%s order=%s fullPage=%s', async (staleOutcome, order, fullPage) => {
    const rows = fullPage ? Array.from({ length: SESSION_LIST_PAGE_SIZE }, (_, index) => ({ ...session, id: `restore-${index}` })) : [];
    invoke.mockResolvedValue({ success: true, data: rows });
    await useSessionStore.getState().loadSessions();
    let finishStale!: (value: unknown) => void;
    let finishLatest!: (value: unknown) => void;
    invoke.mockReturnValueOnce(new Promise((resolve) => { finishStale = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { finishLatest = resolve; }));
    const foreground = useSessionStore.getState().loadSessions();
    const silent = useSessionStore.getState().loadSessions({ silent: true });
    const staleResponse = staleOutcome === 'error'
      ? { success: false, error: { code: 'NETWORK_ERROR', message: 'stale read failed' } }
      : { success: true, data: [{ ...session, id: 'stale-row' }] };
    expect(useSessionStore.getState().isLoading).toBe(true);
    if (order === 'stale-first') {
      finishStale(staleResponse);
      await foreground;
      // A stale completion must not end loading for the still-pending winner.
      expect(useSessionStore.getState().isLoading).toBe(true);
    }
    finishLatest({ success: true, data: rows });
    await silent;
    expect(useSessionStore.getState().isLoading).toBe(false);
    expect(useSessionListLoadStore.getState()).toMatchObject({ settled: true, loading: false, error: false });
    if (order === 'latest-first') {
      finishStale(staleResponse);
      await foreground;
    }
    expect(useSessionStore.getState().isLoading).toBe(false);
    expect(useSessionStore.getState().error).toBeNull();
    expect(useSessionStore.getState().sessions.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    if (fullPage) {
      const readsBeforeOlder = invoke.mock.calls.length;
      await useSessionStore.getState().loadOlderSessions();
      expect(invoke.mock.calls.length).toBe(readsBeforeOlder + 1);
      expect(invoke.mock.lastCall?.[2]).toMatchObject({ offset: SESSION_LIST_PAGE_SIZE });
    }
  });

  it('does not clear unrelated session hydration on a standalone no-op silent read', async () => {
    invoke.mockResolvedValue({ success: true, data: [] });
    await useSessionStore.getState().loadSessions();
    useSessionStore.setState({ isLoading: true, isHydratingSession: true });
    await useSessionStore.getState().loadSessions({ silent: true });
    expect(useSessionStore.getState().isLoading).toBe(true);
    expect(useSessionStore.getState().isHydratingSession).toBe(true);
  });
});
