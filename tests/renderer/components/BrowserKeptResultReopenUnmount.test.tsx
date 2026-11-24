// @vitest-environment jsdom
// Clause ②: Reopen is in flight, the panel leaves the Browser tab, then the
// saved HTML arrives. The post-submit page must show after switching back,
// and the POST URL must not open.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchViewContent } from '../../../src/renderer/components/WorkbenchViewContent';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSurfaceExecutionStore } from '../../../src/renderer/stores/surfaceExecutionStore';
import type { KeptResultPage } from '../../../src/renderer/services/keptResultPage';
import type { useWorkbenchBrowserSession } from '../../../src/renderer/hooks/useWorkbenchBrowserSession';
import type { LiveAgentPointerState } from '../../../src/renderer/hooks/useLiveAgentPointer';
import type { SurfaceLiveFrameStreamState } from '../../../src/renderer/hooks/useSurfaceLiveFrames';

type BrowserSessionState = ReturnType<typeof useWorkbenchBrowserSession>;

const SUBMIT_URL = 'http://127.0.0.1:8898/submit';
const CONVERSATION_ID = 'conversation-a';

const { getKeptResultPage, adoptKeptResultPage, openHttpLinkInRailAsync } = vi.hoisted(() => ({
  getKeptResultPage: vi.fn(),
  adoptKeptResultPage: vi.fn(),
  openHttpLinkInRailAsync: vi.fn(),
}));

vi.mock('../../../src/renderer/services/keptResultPage', () => ({
  getKeptResultPage: (conversationId: string, options?: { includeSnapshot?: boolean }) =>
    getKeptResultPage(conversationId, options),
  adoptKeptResultPage: (input: unknown) => adoptKeptResultPage(input),
}));

vi.mock('../../../src/renderer/services/userBrowserLink', () => ({
  openHttpLinkInRailAsync: (input: unknown) => openHttpLinkInRailAsync(input),
  closeUserBrowserLinkRun: vi.fn(async () => undefined),
  controlUserBrowserHistory: vi.fn(async () => null),
  dispatchUserBrowserInput: vi.fn(async () => null),
  setUserBrowserViewport: vi.fn(async () => null),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchBrowserSession', () => ({
  useWorkbenchBrowserSession: () => browserSessionState,
}));
vi.mock('../../../src/renderer/hooks/useLiveAgentPointer', () => ({
  useLiveAgentPointer: () => pointerState,
}));
vi.mock('../../../src/renderer/hooks/useSurfaceLiveFrames', () => ({
  useSurfaceLiveFrames: () => liveFrameState,
}));

// The task tab's own panel polls the agent tree. This test only needs the
// production switch in WorkbenchViewContent to unmount the browser window.
vi.mock('../../../src/renderer/components/WorkbenchOverview', () => ({
  WorkbenchOverview: () => <div data-testid="workbench-overview-view">任务</div>,
}));

let browserSessionState: BrowserSessionState;
let pointerState: LiveAgentPointerState;
let liveFrameState: SurfaceLiveFrameStreamState;
let resolveSnapshot: (page: KeptResultPage) => void = () => undefined;

function closedPage(snapshotHtml?: string): KeptResultPage {
  return {
    state: 'closed',
    url: SUBMIT_URL,
    title: '报名成功',
    reason: 'keep_result_page',
    reopenMode: 'snapshot',
    ...(snapshotHtml !== undefined ? { snapshotHtml } : {}),
  };
}

function showWorkbench(
  rerender: (ui: React.ReactElement) => void,
  view: 'browser' | 'overview',
): void {
  useAppStore.getState().setActiveWorkbenchTab(view);
  const activeView = useAppStore.getState().activeWorkbenchTab;
  rerender(<WorkbenchViewContent activeView={activeView} onCloseFiles={vi.fn()} />);
}

beforeEach(() => {
  useSurfaceExecutionStore.getState().reset();
  useAppStore.setState({
    language: 'zh',
    activeWorkbenchTab: 'browser',
    workbenchCollapsed: false,
    workingDirectory: '/tmp/w',
  });
  useSessionStore.setState({ currentSessionId: CONVERSATION_ID });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getKeptResultPage.mockReset();
  adoptKeptResultPage.mockReset();
  openHttpLinkInRailAsync.mockReset();
  openHttpLinkInRailAsync.mockResolvedValue({ surfaceSessionId: 'surface-user' });
  pointerState = { event: null, lastEvent: null, isLive: false, timeline: [] };
  liveFrameState = { frame: null, streaming: false, unavailableReason: null };
  browserSessionState = {
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
  } as BrowserSessionState;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSurfaceExecutionStore.getState().reset();
});

async function clickReopenThenLeaveBrowser(): Promise<{
  rerender: (ui: React.ReactElement) => void;
}> {
  const pending = new Promise<KeptResultPage>((resolve) => {
    resolveSnapshot = resolve;
  });
  getKeptResultPage.mockImplementation(async (_id: string, options?: { includeSnapshot?: boolean }) => {
    if (options?.includeSnapshot) return pending;
    return closedPage();
  });

  const view = render(
    <WorkbenchViewContent activeView="browser" onCloseFiles={vi.fn()} />,
  );
  fireEvent.click(await screen.findByTestId('browser-kept-result-reopen'));
  await waitFor(() => {
    expect(getKeptResultPage.mock.calls.some((call) => call[1]?.includeSnapshot === true)).toBe(true);
  });
  expect(openHttpLinkInRailAsync).not.toHaveBeenCalled();

  showWorkbench(view.rerender, 'overview');
  expect(screen.getByTestId('workbench-overview-view')).toBeTruthy();
  expect(screen.queryByTestId('browser-kept-result-reopen')).toBeNull();
  return view;
}

async function settleSnapshot(page: KeptResultPage): Promise<void> {
  await act(async () => {
    resolveSnapshot(page);
    await Promise.resolve();
  });
}

describe('kept result reopen across a workbench tab switch', () => {
  it('shows the saved post-submit page after returning to the browser tab and does not open the submit URL', async () => {
    const { rerender } = await clickReopenThenLeaveBrowser();
    const savedHtml = '<html><body><h1>报名成功</h1></body></html>';
    await settleSnapshot(closedPage(savedHtml));

    expect(openHttpLinkInRailAsync).not.toHaveBeenCalled();
    expect(screen.queryByTestId('browser-kept-result-snapshot-frame')).toBeNull();

    showWorkbench(rerender, 'browser');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    const frame = screen.getByTestId('browser-kept-result-snapshot-frame');
    expect(frame.getAttribute('srcdoc')).toContain('报名成功');
    expect(openHttpLinkInRailAsync).not.toHaveBeenCalled();
  });

  it('does nothing when the snapshot response is empty and the panel has left the browser tab', async () => {
    const { rerender } = await clickReopenThenLeaveBrowser();
    await settleSnapshot(closedPage(''));

    expect(openHttpLinkInRailAsync).not.toHaveBeenCalled();

    showWorkbench(rerender, 'browser');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(screen.queryByTestId('browser-kept-result-snapshot-frame')).toBeNull();
    expect(screen.getByTestId('browser-kept-result-reopen')).toBeTruthy();
    expect(openHttpLinkInRailAsync).not.toHaveBeenCalled();
  });
});
