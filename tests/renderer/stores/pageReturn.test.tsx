// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

let sessions: typeof import('../../../src/renderer/stores/sessionStore');
let app: typeof import('../../../src/renderer/stores/appStore');
let entry: typeof import('../../../src/renderer/hooks/useLedgerDeepLink');
let position: typeof import('../../../src/renderer/hooks/usePageReturn');
let pagehideListeners: MockInstance<typeof window.addEventListener>;
const key = 'neo:page-return';
const rawSession = (id: string, updatedAt: number) => ({
  id, title: id, createdAt: 1, updatedAt, messageCount: 2, turnCount: 1,
  modelConfig: { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
});
const rows = [rawSession('latest', 20), rawSession('older', 10)];

function Probe(): null { entry.useLedgerDeepLink(); return null; }
function VisibleRuns(): null {
  position.usePageReturnPosition({ page: 'automation', runs: true });
  return null;
}
function VisibleSettings(): null {
  position.usePageReturnPosition({ page: 'settings', tab: 'appearance' });
  return null;
}
async function boot() {
  render(<Probe />);
  await act(async () => { await sessions.initializeSessionStore(); });
}
function seed(page: object, sessionId: string | null = 'older') {
  sessionStorage.setItem(key, JSON.stringify({ version: 1, sessionId, position: page }));
}

beforeEach(async () => {
  vi.resetModules();
  pagehideListeners = vi.spyOn(window, 'addEventListener');
  window.history.replaceState({}, '', '/');
  sessionStorage.clear();
  const invoke = vi.fn(async (_domain: string, action: string, args?: { sessionId?: string }) => {
    if (action === 'list') return { success: true, data: rows };
    if (action === 'load') return {
      success: true, data: { ...rows.find((row) => row.id === args?.sessionId), messages: [], todos: [] },
    };
    return { success: true, data: [] };
  });
  Object.assign(window, {
    domainAPI: { invoke },
    electronAPI: { invoke: vi.fn(async () => null), on: vi.fn(() => () => {}), off: vi.fn() },
  });
  sessions = await import('../../../src/renderer/stores/sessionStore');
  app = await import('../../../src/renderer/stores/appStore');
  entry = await import('../../../src/renderer/hooks/useLedgerDeepLink');
  position = await import('../../../src/renderer/hooks/usePageReturn');
});
afterEach(() => {
  cleanup();
  for (const [type, listener, options] of pagehideListeners.mock.calls) {
    if (type === 'pagehide') window.removeEventListener(type, listener, options);
  }
  vi.restoreAllMocks();
});

describe('app startup return-to through useLedgerDeepLink and real session initializer', () => {
  it('restore automation+runs after init and a second same-id startup switch', async () => {
    seed({ page: 'automation', runs: true });
    render(<Probe />);
    expect(app.useAppStore.getState().showCronCenter).toBe(false);
    await act(async () => { await sessions.initializeSessionStore(); });
    expect(app.useAppStore.getState().showCronCenter).toBe(true);
    expect(app.useAppStore.getState().cronCenterRunsRequested).toBe(true);
    await act(async () => { await sessions.useSessionStore.getState().switchSession('older'); });
    expect(app.useAppStore.getState().showCronCenter).toBe(true);
    await act(async () => { await sessions.reloadSessionsForAuthChange(); });
    expect(sessions.useSessionStore.getState().currentSessionId).toBe('older');
    expect(app.useAppStore.getState().showCronCenter).toBe(true);
  });

  it('restore settings tab', async () => {
    seed({ page: 'settings', tab: 'appearance' });
    await boot();
    expect(app.useAppStore.getState()).toMatchObject({ showSettings: true, settingsInitialTab: 'appearance' });
  });

  it('restore session id that is not latest', async () => {
    seed({ page: 'chat' });
    await boot();
    expect(sessions.useSessionStore.getState().currentSessionId).toBe('older');
  });

  it.each(['{broken', JSON.stringify({ version: 77 }), JSON.stringify({
    version: 1, sessionId: 'older', position: { page: 'unknown' },
  })])('ignore corrupt or unknown snapshot with warn: %s', async (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sessionStorage.setItem(key, raw);
    await boot();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Snapshot ignored'), expect.objectContaining({ reason: expect.any(String) }));
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(sessions.useSessionStore.getState().currentSessionId).toBe('latest');
  });

  it('ignore missing session id with reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seed({ page: 'chat' }, 'deleted');
    await boot();
    expect(sessions.useSessionStore.getState().currentSessionId).toBe('latest');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session missing'), expect.any(Object));
  });

  it('one-shot consume; later navigation and pagehide replace rather than re-pin it', async () => {
    seed({ page: 'automation', runs: true });
    await boot();
    expect(sessionStorage.getItem(key)).toBeNull();
    fireEvent.pointerDown(window);
    await act(async () => { await sessions.useSessionStore.getState().switchSession('latest'); });
    expect(app.useAppStore.getState().showCronCenter).toBe(false);
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ sessionId: 'latest', position: { page: 'chat' } });
    cleanup();
    await boot();
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(app.useAppStore.getState().showCronCenter).toBe(false);
  });

  it('deep link ?open=automation wins over settings snapshot', async () => {
    seed({ page: 'settings', tab: 'appearance' });
    window.history.replaceState({}, '', '/?open=automation');
    await boot();
    expect(app.useAppStore.getState().showCronCenter).toBe(true);
    expect(app.useAppStore.getState().showSettings).toBe(false);
    expect(sessions.useSessionStore.getState().currentSessionId).toBe('latest');
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('cold start without snapshot still opens latest', async () => {
    await boot();
    expect(sessions.useSessionStore.getState().currentSessionId).toBe('latest');
    expect(app.useAppStore.getState().showCronCenter).toBe(false);
  });

  it('pagehide captures actual runs selection after request flag was consumed', async () => {
    await boot();
    render(<VisibleRuns />);
    act(() => {
      app.useAppStore.getState().openCronCenterRuns();
      app.useAppStore.getState().clearCronCenterRunsRequest();
    });
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ position: { page: 'automation', runs: true } });
  });

  it('pagehide captures actual settings tab after initial tab was consumed', async () => {
    await boot();
    render(<VisibleSettings />);
    act(() => {
      app.useAppStore.getState().openSettingsTab('appearance');
      app.useAppStore.getState().clearSettingsInitialTab();
    });
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ position: { page: 'settings', tab: 'appearance' } });
  });

  it('storage denied at read/write warns without breaking startup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    await boot();
    window.dispatchEvent(new Event('pagehide'));
    expect(sessions.useSessionStore.getState().currentSessionId).toBe('latest');
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('Snapshot storage'))).toHaveLength(2);
  });

  it('unsupported secondary pages do not turn into a remembered chat', async () => {
    await boot();
    fireEvent.pointerDown(window);
    await act(async () => { await sessions.useSessionStore.getState().switchSession('older'); });
    act(() => { app.useAppStore.getState().setShowLibraryPanel(true); });
    window.dispatchEvent(new Event('pagehide'));
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('startup replay expires even without user input', async () => {
    seed({ page: 'automation', runs: true });
    await boot();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8_001);
    await act(async () => { await sessions.useSessionStore.getState().switchSession('latest'); });
    expect(app.useAppStore.getState().showCronCenter).toBe(false);
    expect(sessions.useSessionStore.getState().currentSessionId).toBe('latest');
  });

  it('pagehide writer survives App unmount into ErrorBoundary', async () => {
    await boot();
    render(<VisibleRuns />);
    act(() => { app.useAppStore.getState().openCronCenterRuns(); });
    cleanup(); // ErrorBoundary has replaced the App; its reload button still uses pagehide.
    expect(sessionStorage.getItem(key)).toBeNull();
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({
      position: { page: 'automation', runs: true },
    });
  });

  it('StrictMode consumes once and still restores', async () => {
    seed({ page: 'automation', runs: true });
    render(<React.StrictMode><Probe /></React.StrictMode>);
    await act(async () => { await sessions.initializeSessionStore(); });
    expect(app.useAppStore.getState().showCronCenter).toBe(true);
    expect(sessionStorage.getItem(key)).toBeNull();
  });
});
