import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type IpcEventHandlers } from '../../../src/shared/ipc';
import { ipcService } from '../../../src/renderer/services/ipcService';
import { applyPermissionQueueEvent } from '../../../src/renderer/hooks/agent/effects/usePermissionQueueEffects';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import capture from './fixtures/liveHelperApproval.json';

type Event = Parameters<IpcEventHandlers[typeof IPC_CHANNELS.AGENT_EVENT]>[0];
const originalWindow = globalThis.window;
let receive: (event: Event) => void;
let unsubscribe: (() => void) | undefined;
const delivered = vi.fn();

function feed(event: Event): void {
  delivered(event);
  const state = useAppStore.getState();
  applyPermissionQueueEvent(event, {
    clearForegroundPermissionRequestsForSession: state.clearForegroundPermissionRequestsForSession,
    removePermissionRequestsForBackgroundRun: state.removePermissionRequestsForBackgroundRun,
    debug: vi.fn(),
    enqueuePermissionRequest: state.enqueuePermissionRequest,
    getCurrentSessionId: () => capture.approval.sessionId,
    hasPermissionRequest: (id) => useAppStore.getState().pendingPermissionRequest?.id === id,
    getPendingPermissionRequest: () => useAppStore.getState().pendingPermissionRequest,
    markSessionUnread: vi.fn(),
    now: Date.now,
    setLastEventAt: vi.fn(),
    setPendingPermissionRequest: state.setPendingPermissionRequest,
    recordPermissionDecision: state.recordPermissionDecision,
    dismissPermissionRequest: state.dismissPermissionRequest,
  });
}

describe('live helper approval overtaken by the global stream', () => {
  beforeEach(() => {
    delivered.mockClear();
    useAppStore.setState({ pendingPermissionRequest: null, pendingPermissionSessionId: null,
      queuedPermissionRequests: {}, resolvedPermissionRequests: {} });
    vi.stubGlobal('window', { codeAgentAPI: { on: (channel: string, cb: typeof receive) => {
      if (channel === IPC_CHANNELS.AGENT_EVENT) receive = cb;
      return () => undefined;
    } } });
    unsubscribe = ipcService.on(IPC_CHANNELS.AGENT_EVENT, feed);
  });

  afterEach(() => {
    unsubscribe?.();
    vi.unstubAllGlobals();
    globalThis.window = originalWindow;
  });

  it('delivers the captured Bash approval after foreground completion and a higher global seq', () => {
    receive(capture.complete as Event);
    receive(capture.overtaking as Event);
    receive(capture.approval as Event);
    expect(delivered).toHaveBeenCalledTimes(3);
    expect(useAppStore.getState().pendingPermissionRequest).toMatchObject({
      id: capture.approval.data.id, tool: 'Bash', agentId: capture.approval.data.agentId,
    });
    expect(useAppStore.getState().pendingPermissionSessionId).toBe(capture.approval.sessionId);
    receive(capture.approval as Event);
    expect(delivered).toHaveBeenCalledTimes(3);
    // The late approval must not roll the ordinary event watermark back.
    receive(capture.overtaking as Event);
    expect(delivered).toHaveBeenCalledTimes(3);
  });

  it('does not resurrect a pending copy that arrives after its resolution', () => {
    receive({ ...capture.approval, seq: capture.overtaking.seq + 1,
      data: { ...capture.approval.data, resolved: true } } as Event);
    receive(capture.approval as Event);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
  });

  it('keeps request identities independent and clears approval history on a new epoch', () => {
    receive(capture.overtaking as Event);
    receive(capture.approval as Event);
    receive({ ...capture.approval, data: { ...capture.approval.data, id: 'another-request' } } as Event);
    expect(delivered).toHaveBeenCalledTimes(3);
    receive({ ...capture.approval, streamEpoch: 'http:restarted', seq: 1 } as Event);
    expect(delivered).toHaveBeenCalledTimes(4);
  });
});
