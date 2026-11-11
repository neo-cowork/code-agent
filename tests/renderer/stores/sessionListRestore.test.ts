// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore, reloadSessionsForAuthChange } from '../../../src/renderer/stores/sessionStore';
import { resetSessionListLoadState, useSessionListLoadStore } from '../../../src/renderer/stores/sessionListPagination';
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
