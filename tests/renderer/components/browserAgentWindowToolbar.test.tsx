// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAgentWindow } from '../../../src/renderer/components/workbench/BrowserAgentWindow';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
import type { SurfaceConversationSnapshotV1 } from '../../../src/shared/contract/surfaceExecution';
import type { useWorkbenchBrowserSession } from '../../../src/renderer/hooks/useWorkbenchBrowserSession';
import type { LiveAgentPointerState } from '../../../src/renderer/hooks/useLiveAgentPointer';
import type { SurfaceLiveFrameStreamState } from '../../../src/renderer/hooks/useSurfaceLiveFrames';

type BrowserSessionState = ReturnType<typeof useWorkbenchBrowserSession>;

const openHttpLinkInRailAsync = vi.fn(async (_input: unknown) => ({
  conversationId: 'session-a',
  runId: 'run-a',
  surfaceSessionId: 'surface-user',
  snapshot: { version: 1, conversationId: 'session-a', sessions: [], updatedAt: 1 },
}));
const closeUserBrowserLinkRun = vi.fn(async (..._args: unknown[]) => undefined);
const controlUserBrowserHistory = vi.fn(async (..._args: unknown[]) => null);
const openExternalLink = vi.fn((_href?: string) => true);
const getKeptResultPage = vi.fn(async (_conversationId?: string): Promise<unknown> => ({
  state: 'none',
  url: null,
  title: null,
  reason: null,
}));
const adoptKeptResultPage = vi.fn(async (_input?: unknown): Promise<unknown> => undefined);

let browserSessionState: BrowserSessionState;
let pointerState: LiveAgentPointerState;
let liveFrameState: SurfaceLiveFrameStreamState;

vi.mock('../../../src/renderer/hooks/useWorkbenchBrowserSession', () => ({
  useWorkbenchBrowserSession: () => browserSessionState,
}));
vi.mock('../../../src/renderer/hooks/useLiveAgentPointer', () => ({
  useLiveAgentPointer: () => pointerState,
}));
vi.mock('../../../src/renderer/hooks/useSurfaceLiveFrames', () => ({
  useSurfaceLiveFrames: () => liveFrameState,
}));
vi.mock('../../../src/renderer/services/keptResultPage', () => ({
  getKeptResultPage: (conversationId: string) => getKeptResultPage(conversationId),
  adoptKeptResultPage: (input: unknown) => adoptKeptResultPage(input),
}));
vi.mock('../../../src/renderer/services/userBrowserLink', () => ({
  openHttpLinkInRailAsync: (input: unknown) => openHttpLinkInRailAsync(input),
  closeUserBrowserLinkRun: (...args: unknown[]) => closeUserBrowserLinkRun(...args),
  controlUserBrowserHistory: (...args: unknown[]) => controlUserBrowserHistory(...args),
  dispatchUserBrowserInput: vi.fn(async () => null),
  setUserBrowserViewport: vi.fn(async () => null),
}));
vi.mock('../../../src/renderer/utils/platform', async () => {
  const actual = await vi.importActual<typeof import('../../../src/renderer/utils/platform')>(
    '../../../src/renderer/utils/platform',
  );
  return {
    ...actual,
    openExternalLink: (href: string | undefined) => openExternalLink(href),
  };
});

function buildBrowserSessionState(overrides: Partial<BrowserSessionState> = {}): BrowserSessionState {
  return {
    mode: 'managed',
    managedSession: { running: false, tabCount: 0, activeTab: null },
    computerSurface: null,
    preview: null,
    readinessItems: [],
    blocked: false,
    repairActions: [],
    busyActionKind: null,
    actionError: null,
    ownedByCurrentSession: true,
    browserSurfaceSessionId: null,
    browserSurfaceTitle: null,
    browserSurfaceOrigin: null,
    refresh: async () => undefined,
    probePermissions: async () => undefined,
    runRepairAction: async () => undefined,
    ...overrides,
  } as BrowserSessionState;
}

describe('BrowserAgentWindow 工具条可用态（N2）', () => {
  beforeEach(() => {
    openHttpLinkInRailAsync.mockClear();
    controlUserBrowserHistory.mockClear();
    openExternalLink.mockClear();
    useAppStore.setState({
      language: 'zh',
      activeWorkbenchTab: 'browser',
      workbenchCollapsed: false,
      workingDirectory: '/tmp/workspace-a',
    });
    useSessionStore.setState({ currentSessionId: 'session-a' });
    useSurfaceExecutionStore.setState({
      nativeByConversation: {},
      compatibilityByConversation: {},
      sessionsByScope: {},
      frameByScope: {},
      evidenceByScope: {},
      controlByScope: {},
    });
    pointerState = { event: null, lastEvent: null, isLive: false, timeline: [] };
    liveFrameState = { frame: null, streaming: false, unavailableReason: null };
    browserSessionState = buildBrowserSessionState();
  });

  afterEach(() => cleanup());

  it('无页面时后退/前进/刷新置灰', () => {
    render(<BrowserAgentWindow />);
    expect((screen.getByTestId('browser-agent-window-nav-back') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('browser-agent-window-nav-forward') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('browser-agent-window-nav-reload') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('browser-agent-window-open-external') as HTMLButtonElement).disabled).toBe(true);
  });

  it('有页面但无历史时后退/前进置灰，刷新可点', async () => {
    browserSessionState = buildBrowserSessionState({
      managedSession: {
        running: true,
        tabCount: 1,
        activeTab: {
          id: 'tab-1',
          title: 'Example',
          url: 'https://example.com/',
          canGoBack: false,
          canGoForward: false,
        },
      },
      preview: { mode: 'managed', title: 'Example', url: 'https://example.com/' },
      browserSurfaceSessionId: 'surface-1',
      browserSurfaceTitle: 'Example',
      browserSurfaceOrigin: 'https://example.com',
    });
    render(<BrowserAgentWindow />);

    expect((screen.getByTestId('browser-agent-window-nav-back') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('browser-agent-window-nav-forward') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('browser-agent-window-nav-reload') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('browser-agent-window-nav-reload'));
    await vi.waitFor(() => expect(controlUserBrowserHistory).toHaveBeenCalledWith({
      conversationId: 'session-a',
      workspace: '/tmp/workspace-a',
      action: 'reload',
    }));
  });

  it('有历史时后退可点并调用 host history control', async () => {
    browserSessionState = buildBrowserSessionState({
      managedSession: {
        running: true,
        tabCount: 1,
        activeTab: {
          id: 'tab-1',
          title: 'Example',
          url: 'https://example.com/page',
          canGoBack: true,
          canGoForward: true,
        },
      },
      preview: { mode: 'managed', title: 'Example', url: 'https://example.com/page' },
      browserSurfaceSessionId: 'surface-1',
      browserSurfaceTitle: 'Example',
      browserSurfaceOrigin: 'https://example.com',
    });
    render(<BrowserAgentWindow />);

    fireEvent.click(screen.getByTestId('browser-agent-window-nav-back'));
    await vi.waitFor(() => expect(controlUserBrowserHistory).toHaveBeenCalledWith({
      conversationId: 'session-a',
      workspace: '/tmp/workspace-a',
      action: 'back',
    }));

    fireEvent.click(screen.getByTestId('browser-agent-window-open-external'));
    expect(openExternalLink).toHaveBeenCalledWith('https://example.com/page');
  });
});

function seedActiveUserLinkSession(): void {
  const capabilities = {
    version: 1 as const,
    surface: 'browser' as const,
    provider: 'managed',
    protocolVersion: '2',
    operations: ['observe' as const],
    observationKinds: ['screenshot' as const],
    supports: { cancel: true, pause: false, takeover: true, cleanup: true, successorObservation: false },
  };
  const activeTarget = {
    kind: 'browser' as const,
    browserInstanceId: 'browser-1',
    windowRef: 'win-1',
    tabRef: 'tab-1',
    documentRevision: 'rev-1',
    origin: 'http://127.0.0.1:8898',
    title: '报名成功',
  };
  const snapshot: SurfaceConversationSnapshotV1 = {
    version: 1,
    conversationId: 'session-a',
    sessions: [
      {
        version: 1,
        session: {
          version: 1,
          sessionId: 'surface-agent-done',
          conversationId: 'session-a',
          runId: 'run-agent',
          agentId: 'agent-a',
          surface: 'browser',
          provider: 'managed',
          capabilities,
          state: 'completed',
          activeTarget,
          startedAt: 1_000,
          heartbeatAt: 61_000,
        },
        grant: { state: 'none', capabilities: [], actionClasses: [], dataScopes: [] },
        events: [],
        evidence: [],
        outputs: [],
        availableControls: [],
        source: 'persisted',
        writable: false,
        updatedAt: 61_000,
      },
      {
        version: 1,
        session: {
          version: 1,
          sessionId: 'surface-user-link',
          conversationId: 'session-a',
          runId: 'user-browser-link:run-1',
          agentId: 'user-browser-link',
          surface: 'browser',
          provider: 'managed',
          capabilities,
          state: 'running',
          activeTarget,
          startedAt: 2_000,
          heartbeatAt: 62_000,
        },
        grant: { state: 'none', capabilities: [], actionClasses: [], dataScopes: [] },
        events: [],
        evidence: [],
        outputs: [],
        availableControls: [],
        source: 'persisted',
        writable: false,
        updatedAt: 62_000,
      },
    ],
    updatedAt: 62_000,
  };
  useSurfaceExecutionStore.getState().setNativeSnapshot('session-a', snapshot);
}

describe('BrowserAgentWindow kept result bar under active user-browser-link session', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useAppStore.setState({
      language: 'zh',
      showLocalOpsPanel: false,
      workingDirectory: null,
      localOpsTab: 'desktop',
      activeWorkbenchTab: 'browser',
      workbenchCollapsed: false,
      processingSessionIds: new Set(),
      isProcessing: false,
    });
    useSessionStore.setState({ currentSessionId: 'session-a', runningSessionIds: new Set() });
    useSurfaceExecutionStore.getState().reset();
    pointerState = { event: null, lastEvent: null, isLive: false, timeline: [] };
    liveFrameState = { frame: null, streaming: false, unavailableReason: null };
    browserSessionState = buildBrowserSessionState({ browserSurfaceSessionId: 'surface-user-link' });
    getKeptResultPage.mockReset().mockResolvedValue({ state: 'none', url: null, title: null, reason: null });
    adoptKeptResultPage.mockReset().mockResolvedValue({ surfaceSessionId: 'surface-user-link' });
    openHttpLinkInRailAsync.mockClear();
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ processingSessionIds: new Set(), isProcessing: false });
    useSessionStore.setState({ runningSessionIds: new Set() });
    vi.useRealTimers();
  });

  it('renders kept bar and overlay marker when user-browser-link session stays active', async () => {
    seedActiveUserLinkSession();
    getKeptResultPage.mockResolvedValue({
      state: 'kept',
      url: 'http://127.0.0.1:8898/submit',
      title: '报名成功',
      reason: 'keep_result_page',
    });
    render(<BrowserAgentWindow />);

    expect(screen.queryByTestId('browser-agent-window-terminal-frame')).toBeNull();
    expect(screen.queryByTestId('browser-agent-window-terminal-summary')).toBeNull();

    const bar = await screen.findByTestId('browser-kept-result-bar-kept');
    expect(bar.textContent).toContain('结果页已保留');
    expect(bar.textContent).toContain('报名成功');

    const adoptButton = screen.getByTestId('browser-kept-result-adopt');
    expect(adoptButton.closest('[data-browser-stage-overlay]')).not.toBeNull();
    fireEvent.click(adoptButton);
    await waitFor(() => expect(adoptKeptResultPage).toHaveBeenCalledWith({
      conversationId: 'session-a',
      workspace: null,
    }));
  });

  it('refreshes immediately on conversation run end without waiting for the 30s poll', async () => {
    seedActiveUserLinkSession();
    useAppStore.getState().setSessionProcessing('session-a', true);
    getKeptResultPage.mockResolvedValue({ state: 'none', url: null, title: null, reason: null });

    render(<BrowserAgentWindow />);
    await waitFor(() => expect(getKeptResultPage).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('browser-kept-result-bar-kept')).toBeNull();

    getKeptResultPage.mockResolvedValue({
      state: 'kept',
      url: 'http://127.0.0.1:8898/submit',
      title: '报名成功',
      reason: 'keep_result_page',
    });
    await act(async () => {
      useAppStore.getState().setSessionProcessing('session-a', false);
    });

    const bar = await screen.findByTestId('browser-kept-result-bar-kept');
    expect(bar.textContent).toContain('报名成功');
    expect(getKeptResultPage).toHaveBeenCalledTimes(2);
  });

  it('renders closed state and URL-only reopen under active user-browser-link session', async () => {
    seedActiveUserLinkSession();
    getKeptResultPage.mockResolvedValue({
      state: 'closed',
      url: 'http://127.0.0.1:8898/submit',
      title: '报名成功',
      reason: 'keep_result_page',
    });
    render(<BrowserAgentWindow />);

    const bar = await screen.findByTestId('browser-kept-result-bar-closed');
    expect(bar.textContent).toContain('结果页已关闭');
    fireEvent.click(screen.getByTestId('browser-kept-result-reopen'));
    await waitFor(() => expect(openHttpLinkInRailAsync).toHaveBeenCalledWith({
      href: 'http://127.0.0.1:8898/submit',
      conversationId: 'session-a',
      workspace: null,
    }));
  });
});
