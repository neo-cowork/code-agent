// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostReasonCode, type AgentEventEnvelope, type ToolResult } from '../../../src/shared/contract';

interface MockPreviewTab {
  id: string;
  path: string;
  kind?: 'file' | 'virtual' | 'liveDev';
}

const mocks = vi.hoisted(() => ({
  listener: null as ((event: AgentEventEnvelope) => void) | null,
  openSurfaceForArtifact: vi.fn(),
  suppressSurfaceIntentForCurrentTurn: vi.fn(),
  appState: {
    workingDirectory: '/workspace',
    activeWorkbenchTab: 'overview' as string | null,
    workbenchTabs: ['overview'] as string[],
    previewTabs: [] as MockPreviewTab[],
    openPreview: vi.fn(),
    closePreviewTab: vi.fn(),
  },
  sessionState: { currentSessionId: 'session-1' as string | null },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    on: vi.fn((_channel: string, listener: (event: AgentEventEnvelope) => void) => {
      mocks.listener = listener;
      return () => { mocks.listener = null; };
    }),
  },
}));

vi.mock('../../../src/renderer/services/surfaceIntentDispatcher', () => ({
  openSurfaceForArtifact: mocks.openSurfaceForArtifact,
}));

vi.mock('../../../src/renderer/services/surfaceIntentRuntime', () => ({
  suppressSurfaceIntentForCurrentTurn: mocks.suppressSurfaceIntentForCurrentTurn,
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: { getState: () => mocks.appState },
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: { getState: () => mocks.sessionState },
}));

const { useArtifactFollow } = await import('../../../src/renderer/hooks/useArtifactFollow');
const { artifactFollowKey, useArtifactFollowStore } = await import(
  '../../../src/renderer/stores/artifactFollowStore'
);

function emit(event: AgentEventEnvelope): void {
  act(() => mocks.listener?.(event));
}

function writeStart(): AgentEventEnvelope {
  return {
    type: 'tool_call_start',
    streamEpoch: 'native:artifact-follow-test',
    sessionId: 'session-1',
    seq: 1,
    data: {
      id: 'write-1',
      name: 'Write',
      arguments: { file_path: 'report.html', content: '<main />' },
    },
  };
}

function writeEnd(result: Partial<ToolResult> & Pick<ToolResult, 'success'>): AgentEventEnvelope {
  return {
    type: 'tool_call_end',
    streamEpoch: 'native:artifact-follow-test',
    sessionId: 'session-1',
    seq: 2,
    data: {
      toolCallId: 'write-1',
      ...result,
    },
  };
}

let nextTabCounter = 0;

function seedPreviewTab(filePath: string): MockPreviewTab {
  nextTabCounter += 1;
  const tab: MockPreviewTab = { id: `ptab-${nextTabCounter}`, path: filePath, kind: 'file' };
  const workbenchId = `preview:${filePath}`;
  if (!mocks.appState.previewTabs.some((item) => item.kind !== 'liveDev' && item.path === filePath)) {
    mocks.appState.previewTabs = [...mocks.appState.previewTabs, tab];
  }
  if (!mocks.appState.workbenchTabs.includes(workbenchId)) {
    mocks.appState.workbenchTabs = [...mocks.appState.workbenchTabs, workbenchId];
  }
  return tab;
}

beforeEach(() => {
  nextTabCounter = 0;
  mocks.appState.activeWorkbenchTab = 'overview';
  mocks.appState.workbenchTabs = ['overview'];
  mocks.appState.previewTabs = [];
  mocks.appState.openPreview.mockReset();
  mocks.appState.openPreview.mockImplementation((filePath: string, options?: { activate?: boolean }) => {
    const resolved = filePath.startsWith('/') ? filePath : `${mocks.appState.workingDirectory}/${filePath}`;
    seedPreviewTab(resolved);
    if (options?.activate !== false) {
      mocks.appState.activeWorkbenchTab = `preview:${resolved}`;
    }
  });
  mocks.appState.closePreviewTab.mockReset();
  mocks.appState.closePreviewTab.mockImplementation((id: string) => {
    const closing = mocks.appState.previewTabs.find((tab) => tab.id === id);
    if (!closing) return;
    mocks.appState.previewTabs = mocks.appState.previewTabs.filter((tab) => tab.id !== id);
    mocks.appState.workbenchTabs = mocks.appState.workbenchTabs.filter(
      (view) => view !== `preview:${closing.path}`,
    );
    if (mocks.appState.activeWorkbenchTab === `preview:${closing.path}`) {
      mocks.appState.activeWorkbenchTab = mocks.appState.workbenchTabs[0] ?? null;
    }
  });
  mocks.openSurfaceForArtifact.mockReset();
  mocks.openSurfaceForArtifact.mockImplementation((input: { artifact: { kind: string; filePath?: string } }) => {
    const filePath = input.artifact.filePath ?? '/workspace/report.html';
    mocks.appState.openPreview(filePath, { activate: true });
    return { view: 'file-preview', filePath };
  });
  mocks.suppressSurfaceIntentForCurrentTurn.mockReset();
  mocks.sessionState.currentSessionId = 'session-1';
  useArtifactFollowStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.innerHTML = '';
});

describe('useArtifactFollow', () => {
  it('opens the preview automatically when a supported file write starts while idle', () => {
    const { unmount } = renderHook(() => useArtifactFollow());
    emit(writeStart());

    expect(mocks.openSurfaceForArtifact).toHaveBeenCalledWith({
      artifact: { kind: 'file-preview', filePath: '/workspace/report.html' },
      artifactSessionId: 'session-1',
    });
    expect(useArtifactFollowStore.getState().entries[
      artifactFollowKey('session-1', '/workspace/report.html')
    ]?.attention).toBe(false);
    unmount();
  });

  it('opens in the background with attention when the user recently clicked the workbench', () => {
    document.body.innerHTML = `
      <div id="workbench-root">
        <div data-testid="workbench-view-selector"></div>
        <button id="active-control">active</button>
      </div>
    `;
    const { unmount } = renderHook(() => useArtifactFollow());
    fireEvent.pointerDown(document.getElementById('active-control')!);
    emit(writeStart());

    expect(mocks.openSurfaceForArtifact).not.toHaveBeenCalled();
    expect(mocks.appState.openPreview).toHaveBeenCalledWith('/workspace/report.html', {
      source: 'auto',
      activate: false,
    });
    expect(useArtifactFollowStore.getState().entries[
      artifactFollowKey('session-1', '/workspace/report.html')
    ]?.attention).toBe(true);
    expect(mocks.suppressSurfaceIntentForCurrentTurn).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('closes the auto-opened preview tab and drops the follow entry when Write is denied by the user', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useArtifactFollow());
    emit(writeStart());
    expect(mocks.appState.previewTabs.map((tab) => tab.path)).toEqual(['/workspace/report.html']);

    // Queue a trailing refresher before denial to verify settleFollow cancels it too.
    emit({
      type: 'tool_progress',
      streamEpoch: 'native:artifact-follow-test',
      sessionId: 'session-1',
      seq: 2,
      data: { toolCallId: 'write-1', stage: 'running', progress: 10 },
    });
    emit({
      type: 'tool_progress',
      streamEpoch: 'native:artifact-follow-test',
      sessionId: 'session-1',
      seq: 3,
      data: { toolCallId: 'write-1', stage: 'running', progress: 20 },
    });

    emit(writeEnd({
      success: false,
      error: 'Permission denied by user: Write',
      metadata: {
        hostReason: {
          code: HostReasonCode.PermissionDeniedByUser,
          modelText: 'Permission denied by user: Write',
        },
      },
    }));

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(mocks.appState.closePreviewTab).toHaveBeenCalledTimes(1);
    expect(mocks.appState.previewTabs).toEqual([]);
    expect(mocks.appState.workbenchTabs).not.toContain('preview:/workspace/report.html');
    expect(
      useArtifactFollowStore.getState().entries[
        artifactFollowKey('session-1', '/workspace/report.html')
      ],
    ).toBeUndefined();
    unmount();
  });

  it('keeps the preview tab open and marks follow complete when Write succeeds', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useArtifactFollow());
    emit(writeStart());
    emit(writeEnd({
      success: true,
      output: 'Wrote /workspace/report.html',
    }));

    act(() => {
      vi.advanceTimersByTime(1_200);
    });

    expect(mocks.appState.closePreviewTab).not.toHaveBeenCalled();
    expect(mocks.appState.previewTabs.map((tab) => tab.path)).toEqual(['/workspace/report.html']);
    expect(mocks.appState.workbenchTabs).toContain('preview:/workspace/report.html');
    expect(
      useArtifactFollowStore.getState().entries[
        artifactFollowKey('session-1', '/workspace/report.html')
      ]?.phase,
    ).toBe('complete');
    unmount();
  });

  it('keeps a pre-existing preview tab open without marking it complete when Write is denied', () => {
    vi.useFakeTimers();
    seedPreviewTab('/workspace/report.html');
    const { unmount } = renderHook(() => useArtifactFollow());

    emit(writeStart());
    emit(writeEnd({
      success: false,
      error: 'Permission denied by user: Write',
      metadata: {
        hostReason: {
          code: HostReasonCode.PermissionDeniedByUser,
          modelText: 'Permission denied by user: Write',
        },
      },
    }));

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(mocks.appState.closePreviewTab).not.toHaveBeenCalled();
    expect(mocks.appState.previewTabs.map((tab) => tab.path)).toEqual(['/workspace/report.html']);
    expect(mocks.appState.workbenchTabs).toContain('preview:/workspace/report.html');
    expect(
      useArtifactFollowStore.getState().entries[
        artifactFollowKey('session-1', '/workspace/report.html')
      ],
    ).toBeUndefined();
    unmount();
  });
});
