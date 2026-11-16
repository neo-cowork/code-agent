// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentWindow } from '../../../src/renderer/components/workbench/BrowserAgentWindow';
import { WorkbenchTabs } from '../../../src/renderer/components/WorkbenchTabs';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useWorkbenchFocusStore } from '../../../src/renderer/stores/workbenchFocusStore';
import { SurfaceLiveStreamService } from '../../../src/host/services/surfaceExecution/SurfaceLiveStreamService';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { SurfaceLiveFrameV1 } from '../../../src/shared/contract/surfaceExecution';

const harness = vi.hoisted(() => ({
  listeners: new Map<string, (frame: unknown) => void>(),
  start: vi.fn(), stop: vi.fn(), emit: (_frame: unknown) => {},
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: {
  on: (channel: string, callback: (frame: unknown) => void) => {
    harness.listeners.set(channel, callback);
    return () => harness.listeners.delete(channel);
  },
  invoke: vi.fn(async () => undefined),
} }));
vi.mock('../../../src/renderer/services/surfaceExecutionClient', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  startSurfaceLiveStream: (request: unknown) => harness.start(request),
  stopSurfaceLiveStream: (id: string) => harness.stop(id),
  getPersistedSurfaceTerminalFrame: vi.fn(async () => null),
  persistSurfaceTerminalFrame: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../../src/renderer/hooks/useWorkbenchBrowserSession', () => ({
  useWorkbenchBrowserSession: () => ({
    mode: 'managed', ownedByCurrentSession: true, browserSurfaceSessionId: 'surface-1',
    browserSurfaceTitle: 'Signup', browserSurfaceOrigin: 'http://localhost/signup.html',
    managedSession: { running: true, tabCount: 1, activeTab: { title: 'Signup', url: 'http://localhost/signup.html' } },
    preview: null, readinessItems: [], repairActions: [],
  }),
}));
vi.mock('../../../src/renderer/hooks/useLiveAgentPointer', () => ({
  useLiveAgentPointer: () => ({ event: null, lastEvent: null, isLive: false, timeline: [] }),
}));
vi.mock('../../../src/host/services/infra/browser/pageScreencast', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  startPageScreencast: async (_page: unknown, _options: unknown, emit: (frame: unknown) => void) => {
    harness.emit = emit;
    return { stop: async () => undefined };
  },
}));
vi.mock('../../../src/host/services/infra/logger', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

let service: SurfaceLiveStreamService;
let published: SurfaceLiveFrameV1[];

beforeEach(() => {
  harness.listeners.clear();
  published = [];
  const page = { context: () => ({ newCDPSession: async () => ({
    send: async () => ({ cssContentSize: { width: 500 }, cssLayoutViewport: { clientWidth: 320 } }),
    detach: async () => undefined,
  }) }) };
  service = new SurfaceLiveStreamService(
    { sessions: { get: () => ({ conversationId: 'session-a', surface: 'browser' }) } } as never,
    { findBindingBySurfaceSessionId: () => ({ browserService: {
      isRunning: () => true, getActiveTab: () => ({ page }),
    } }) } as never,
    (frame) => { published.push(frame); harness.listeners.get(IPC_CHANNELS.SURFACE_LIVE_FRAME)?.(frame); },
  );
  harness.start.mockImplementation((request) => service.start(request));
  harness.stop.mockImplementation((id) => service.stop(id));
  useAppStore.setState({ language: 'zh', activeWorkbenchTab: 'browser', workbenchTabs: ['browser'],
    workbenchCollapsed: false, workingDirectory: null });
  useSessionStore.setState({ currentSessionId: 'session-a' });
  useWorkbenchFocusStore.setState({ workbenchFocused: false });
});
afterEach(async () => { cleanup(); await service.stop('surface-1'); });

async function show(focusable = true) {
  const view = render(<WorkbenchTabs focusable={focusable}><BrowserAgentWindow /></WorkbenchTabs>);
  await waitFor(() => expect(service.isStreaming('surface-1')).toBe(true));
  await act(async () => {
    harness.emit({ base64: 'AAAA', width: 320, height: 600, capturedAtMs: 42 });
  });
  return view;
}
function frame(overrides: Partial<SurfaceLiveFrameV1>) {
  act(() => harness.listeners.get(IPC_CHANNELS.SURFACE_LIVE_FRAME)?.({ ...published.at(-1), ...overrides }));
}

describe('BrowserAgentWindow page overflow through real host publish and renderer stream hook', () => {
  it('shows the ZH hint below the stage and enlarges through workbenchFocusStore', async () => {
    await show();
    const hint = screen.getByTestId('browser-page-overflow-hint');
    expect(hint.textContent).toContain('这个网页比面板宽，右侧一部分被挡住了');
    expect(screen.getByTestId('browser-agent-window-stage').contains(hint)).toBe(false);
    expect(screen.getByTestId('browser-agent-window-stage').compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '放大面板' }));
    expect(useWorkbenchFocusStore.getState().workbenchFocused).toBe(true);
    expect(screen.queryByTestId('browser-page-overflow-hint')).toBeNull();
    act(() => useWorkbenchFocusStore.getState().setWorkbenchFocused(false));
    expect(screen.getByTestId('browser-page-overflow-hint')).toBeTruthy();
  });

  it('hides for false/absent metadata and ignores frames from another session or conversation', async () => {
    const view = await show();
    expect(screen.getByTestId('browser-page-overflow-hint')).toBeTruthy();
    frame({ pageOverflowX: false });
    expect(screen.queryByTestId('browser-page-overflow-hint')).toBeNull();
    frame({ pageOverflowX: undefined });
    expect(screen.queryByTestId('browser-page-overflow-hint')).toBeNull();
    frame({ pageOverflowX: true, surfaceSessionId: 'surface-other' });
    expect(screen.queryByTestId('browser-page-overflow-hint')).toBeNull();
    frame({ pageOverflowX: true, conversationId: 'session-other' });
    expect(screen.queryByTestId('browser-page-overflow-hint')).toBeNull();
    frame({ pageOverflowX: true });
    expect(screen.getByTestId('browser-page-overflow-hint')).toBeTruthy();
    // A session switch must hide the last React state frame before the stream effect cleans up.
    act(() => useSessionStore.setState({ currentSessionId: 'session-other' }));
    view.rerender(<WorkbenchTabs focusable><BrowserAgentWindow /></WorkbenchTabs>);
    expect(screen.queryByTestId('browser-page-overflow-hint')).toBeNull();
  });

  it('does not show a dead action when the actual WorkbenchTabs focusable prop is false', async () => {
    await show(false);
    expect(published.at(-1)?.pageOverflowX).toBe(true);
    expect(screen.queryByTestId('browser-page-overflow-hint')).toBeNull();
    expect(screen.queryByRole('button', { name: '放大面板' })).toBeNull();
  });

  it('hides while already focused', async () => {
    useWorkbenchFocusStore.setState({ workbenchFocused: true });
    await show();
    expect(screen.queryByTestId('browser-page-overflow-hint')).toBeNull();
  });

  it('shows the exact EN hint and action', async () => {
    useAppStore.setState({ language: 'en' });
    await show();
    expect(screen.getByText('This page is wider than the panel, so part of it is hidden.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enlarge panel' })).toBeTruthy();
  });
});
