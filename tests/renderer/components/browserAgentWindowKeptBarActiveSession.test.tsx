// @vitest-environment jsdom
// N-FIX-BROWSER-KEEP-RESULT-PAGE-FU2：run 中右栏的视口推送（setUserBrowserViewport →
// ensureRun）会留下常驻的 user-browser-link browser surface 会话，旧挂载条件
// （terminalSurfaceSession）因此永假，kept 条在真实用户路径（FB-1173）上从不渲染。
// 本测试走生产挂载（BrowserAgentWindow + surfaceExecutionStore）：store 里同时有
// 活跃 user-browser-link 会话与 kept 三态时，条必须出现并能认领。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const {
  getKeptResultPage, adoptKeptResultPage, openHttpLinkInRailAsync,
  closeUserBrowserLinkRun, controlUserBrowserHistory, setUserBrowserViewport, dispatchUserBrowserInput,
} = vi.hoisted(() => ({
  getKeptResultPage: vi.fn(),
  adoptKeptResultPage: vi.fn(),
  openHttpLinkInRailAsync: vi.fn(),
  closeUserBrowserLinkRun: vi.fn(),
  controlUserBrowserHistory: vi.fn(),
  setUserBrowserViewport: vi.fn(),
  dispatchUserBrowserInput: vi.fn(),
}));

vi.mock('../../../src/renderer/services/userBrowserLink', () => ({
  getKeptResultPage: (conversationId: string) => getKeptResultPage(conversationId),
  adoptKeptResultPage: (input: unknown) => adoptKeptResultPage(input),
  openHttpLinkInRailAsync: (input: unknown) => openHttpLinkInRailAsync(input),
  closeUserBrowserLinkRun: (input: unknown) => closeUserBrowserLinkRun(input),
  controlUserBrowserHistory: (input: unknown) => controlUserBrowserHistory(input),
  setUserBrowserViewport: (input: unknown) => setUserBrowserViewport(input),
  dispatchUserBrowserInput: (input: unknown) => dispatchUserBrowserInput(input),
  openHttpLinkInRail: vi.fn(() => false),
}));

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

/** 活跃 user-browser-link browser 会话（视口推送会起的那类）+ 已完成的 agent 会话。 */
function seedActiveUserLinkSession(): void {
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
          capabilities: {
            version: 1,
            surface: 'browser',
            provider: 'managed',
            protocolVersion: '2',
            operations: ['observe'],
            observationKinds: ['screenshot'],
            supports: { cancel: true, pause: false, takeover: true, cleanup: true, successorObservation: false },
          },
          state: 'completed',
          activeTarget: {
            kind: 'browser',
            browserInstanceId: 'browser-1',
            windowRef: 'win-1',
            tabRef: 'tab-1',
            documentRevision: 'rev-1',
            origin: 'http://127.0.0.1:8898',
            title: '报名成功',
          },
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
          capabilities: {
            version: 1,
            surface: 'browser',
            provider: 'managed',
            protocolVersion: '2',
            operations: ['observe'],
            observationKinds: ['screenshot'],
            supports: { cancel: true, pause: false, takeover: true, cleanup: true, successorObservation: false },
          },
          state: 'running',
          activeTarget: {
            kind: 'browser',
            browserInstanceId: 'browser-1',
            windowRef: 'win-1',
            tabRef: 'tab-1',
            documentRevision: 'rev-1',
            origin: 'http://127.0.0.1:8898',
            title: '报名成功',
          },
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

describe('BrowserAgentWindow kept 条（活跃 user-browser-link 会话下仍渲染，FU2）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useAppStore.setState({
      language: 'zh',
      showLocalOpsPanel: false,
      localOpsTab: 'desktop',
      activeWorkbenchTab: 'browser',
      workbenchCollapsed: false,
    });
    useSessionStore.setState({ currentSessionId: 'session-a' });
    useSurfaceExecutionStore.getState().reset();
    pointerState = { event: null, lastEvent: null, isLive: false, timeline: [] };
    liveFrameState = { frame: null, streaming: false, unavailableReason: null };
    browserSessionState = buildBrowserSessionState({ browserSurfaceSessionId: 'surface-user-link' });
    getKeptResultPage.mockReset();
    adoptKeptResultPage.mockReset();
    openHttpLinkInRailAsync.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('store 同时有活跃 user-browser-link 会话与 kept 态：条渲染并可认领（旧挂载条件下永不出现）', async () => {
    seedActiveUserLinkSession();
    getKeptResultPage.mockResolvedValue({
      state: 'kept',
      url: 'http://127.0.0.1:8898/submit',
      title: '报名成功',
    });
    adoptKeptResultPage.mockResolvedValue({ surfaceSessionId: 'surface-user-link' });
    render(<BrowserAgentWindow />);

    // 前置：这正是 FB-1173 的死角——活跃会话让终态留影路径整段不亮
    expect(screen.queryByTestId('browser-agent-window-terminal-frame')).toBeNull();
    expect(screen.queryByTestId('browser-agent-window-terminal-summary')).toBeNull();

    const bar = await screen.findByTestId('browser-kept-result-bar-kept');
    expect(bar.textContent).toContain('结果页已保留');
    expect(bar.textContent).toContain('报名成功');

    fireEvent.click(screen.getByTestId('browser-kept-result-adopt'));
    await waitFor(() => expect(adoptKeptResultPage).toHaveBeenCalledWith({
      conversationId: 'session-a',
      workspace: null,
    }));
  });

  it('kept 态为 none（普通会话、无保留）时条不占画面', async () => {
    seedActiveUserLinkSession();
    getKeptResultPage.mockResolvedValue({ state: 'none', url: null, title: null });
    const { container } = render(<BrowserAgentWindow />);

    await waitFor(() => expect(getKeptResultPage).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="browser-kept-result-bar-kept"]')).toBeNull();
    expect(container.querySelector('[data-testid="browser-kept-result-bar-closed"]')).toBeNull();
  });
});
