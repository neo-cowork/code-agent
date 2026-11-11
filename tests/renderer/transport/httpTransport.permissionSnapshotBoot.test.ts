// ============================================================================
// 页面启动时的审批快照不能比 agent:event 监听器早到就被丢
// （N-FIX-BGPANEL-STOP-TERMINAL-FU1-FU1-FU1）
// ----------------------------------------------------------------------------
// 真机（web 构建，默认权限档，coder 子代理 Bash run_in_background）实测：
//   SSE 由最早的 on('posthog:identity') 拉起 → host 的 snapshot:true 审批快照先到 →
//   dispatchSSEPayload 对「还没有监听器」的通道静默丢弃 → 10ms 后 agent:event 监听器才注册。
//   后台子代理在等审批，页面上却永远没有「允许一次」卡。
// 夹具是该次真跑里 /api/events 抓到的原始快照行（fixtures/subagentBashPermissionSnapshot.sse.json）。
// 链路：真 httpTransport → 真 applyPermissionQueueEvent → 真 useAppStore。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RENDERER_POLLING } from '../../../src/shared/constants';
import snapshotLine from './fixtures/subagentBashPermissionSnapshot.sse.json';

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: { getState: () => ({ status: 'disconnected' }) },
}));
vi.mock('../../../src/renderer/services/localBridge', () => ({
  getLocalBridgeClient: () => ({ invokeTool: vi.fn() }),
}));

(globalThis as Record<string, unknown>).window = { __CODE_AGENT_TOKEN__: undefined };

import { createHttpCodeAgentAPI } from '../../../src/renderer/api/httpTransport';
import { applyPermissionQueueEvent } from '../../../src/renderer/hooks/agent/effects/usePermissionQueueEffects';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

interface FakeEventSource {
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  close: () => void;
  emit: (data: unknown) => void;
}

const CLOSED = 2;
const sources: FakeEventSource[] = [];

class FakeEventSourceCtor {
  static CLOSED = CLOSED;
  onmessage: FakeEventSource['onmessage'] = null;
  onerror: FakeEventSource['onerror'] = null;
  readyState = 0;
  constructor(_url: string) {
    sources.push(this as unknown as FakeEventSource);
  }
  close() { this.readyState = CLOSED; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

const SESSION_ID = (snapshotLine.args as { sessionId: string }).sessionId;
const REQUEST_ID = (snapshotLine.args.data as { id: string }).id;

function connectAndPushSnapshot(): void {
  const source = sources[0];
  source.emit({
    channel: 'connected',
    args: { streamEpoch: 'http:test', sessionId: '__sse__', seq: 1, requiresSnapshot: true, reason: 'initial_snapshot' },
  });
  source.emit(snapshotLine);
}

function feedIntoQueue(event: unknown): void {
  const state = useAppStore.getState();
  applyPermissionQueueEvent(event as Parameters<typeof applyPermissionQueueEvent>[0], {
    clearForegroundPermissionRequestsForSession: state.clearForegroundPermissionRequestsForSession,
    removePermissionRequestsForBackgroundRun: state.removePermissionRequestsForBackgroundRun,
    debug: () => undefined,
    enqueuePermissionRequest: state.enqueuePermissionRequest,
    getCurrentSessionId: () => useSessionStore.getState().currentSessionId,
    hasPermissionRequest: (id) => {
      const s = useAppStore.getState();
      return s.pendingPermissionRequest?.id === id
        || Object.values(s.queuedPermissionRequests).some((queue) => queue.some((request) => request.id === id));
    },
    getPendingPermissionRequest: () => useAppStore.getState().pendingPermissionRequest,
    markSessionUnread: () => undefined,
    now: Date.now,
    setLastEventAt: () => undefined,
    setPendingPermissionRequest: state.setPendingPermissionRequest,
    recordPermissionDecision: state.recordPermissionDecision,
    dismissPermissionRequest: state.dismissPermissionRequest,
  });
}

function queuedFor(sessionId: string) {
  const s = useAppStore.getState();
  return [
    ...(s.pendingPermissionRequest && s.pendingPermissionSessionId === sessionId ? [s.pendingPermissionRequest] : []),
    ...(s.queuedPermissionRequests[sessionId] ?? []),
  ];
}

describe('httpTransport: host permission snapshot that beats the agent:event listener', () => {
  const originalEventSource = (globalThis as Record<string, unknown>).EventSource;

  beforeEach(() => {
    sources.length = 0;
    (globalThis as Record<string, unknown>).EventSource = FakeEventSourceCtor;
    vi.useFakeTimers();
    useAppStore.setState({
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {},
      resolvedPermissionRequests: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as Record<string, unknown>).EventSource = originalEventSource;
  });

  it('a card snapshot delivered before the listener registers still reaches the permission queue', () => {
    const api = createHttpCodeAgentAPI('http://127.0.0.1:1');
    api.on('posthog:identity' as never, (() => undefined) as never); // 真机里拉起 SSE 的第一个监听器
    connectAndPushSnapshot(); // 快照先到：此刻还没有 agent:event 监听器

    const received: unknown[] = [];
    api.on('agent:event' as never, ((event: unknown) => {
      received.push(event);
      feedIntoQueue(event);
    }) as never);

    expect(received).toHaveLength(1);
    expect(queuedFor(SESSION_ID).map((request) => request.id)).toEqual([REQUEST_ID]);
    expect(queuedFor(SESSION_ID)[0]).toMatchObject({ tool: 'Bash', agentId: expect.stringContaining('agent_coder') });
  });

  it('a snapshot older than the replay window is not replayed to a much later subscriber', () => {
    const api = createHttpCodeAgentAPI('http://127.0.0.1:1');
    api.on('posthog:identity' as never, (() => undefined) as never);
    connectAndPushSnapshot();
    vi.advanceTimersByTime(RENDERER_POLLING.SSE_PERMISSION_SNAPSHOT_REPLAY_WINDOW + 1);

    const received: unknown[] = [];
    api.on('agent:event' as never, ((event: unknown) => { received.push(event); }) as never);
    expect(received).toHaveLength(0);
  });

  it('a card that the host already closed is not replayed', () => {
    const api = createHttpCodeAgentAPI('http://127.0.0.1:1');
    api.on('posthog:identity' as never, (() => undefined) as never);
    connectAndPushSnapshot();
    sources[0].emit({
      channel: 'agent:event',
      args: {
        type: 'permission_request',
        sessionId: SESSION_ID,
        data: { ...(snapshotLine.args.data as object), resolved: true, decision: 'timeout' },
      },
    });

    const received: unknown[] = [];
    api.on('agent:event' as never, ((event: unknown) => { received.push(event); }) as never);
    expect(received).toHaveLength(0);
  });
});
