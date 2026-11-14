// @vitest-environment jsdom
// N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO
// 后台任务（spawn_agent 子代理 / 后台 Browser 步）的审批卡与前台 run 同 sessionId：
// 前台 run 结束（agent_complete / error / stream_end）不得把后台任务的审批卡一起清掉。
// 这组测试走**生产同款接线**：applyPermissionQueueEvent + 真实 useAppStore
// （usePermissionQueueEffects.ts 里 ipcService.on('agent:event') 的 deps 组装），
// 不用 harness mock——mock 会把被测语义抄一遍，抄一遍就证明不了仓库里的真行为。
import { createElement, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import {
  applyPermissionQueueEvent,
  reconcilePermissionQueue,
  type PermissionQueueEventDeps,
} from '../../../src/renderer/hooks/agent/effects/usePermissionQueueEffects';

const invoke = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: toastError } }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';
import { getSessionWaitingDetail } from '../../../src/renderer/utils/sessionNeedsInput';
import { zh } from '../../../src/renderer/i18n/zh';

type PermissionCardProps = NonNullable<ComponentProps<typeof PermissionCard>>;

function permissionRequest(id: string): PermissionRequest {
  return {
    id,
    type: 'command',
    tool: 'shell',
    details: { command: `echo ${id}` },
    timestamp: 100,
  };
}

/** 后台 lane 的审批请求：同 sessionId/runId、独立 agentId（subagentToolRuntime 把 identity 摊进请求）。 */
function backgroundPermissionRequest(id: string): PermissionRequest {
  return {
    ...permissionRequest(id),
    sessionId: 'session-main',
    agentId: `bg-agent-${id}`,
    runId: 'shared-parent-run',
    parentToolUseId: `tool-${id}`,
  };
}

function createProductionDeps(currentSessionId: string | null): {
  deps: PermissionQueueEventDeps;
  unreadSessionIds: string[];
} {
  const unreadSessionIds: string[] = [];
  const deps: PermissionQueueEventDeps = {
    // 与 src/renderer/hooks/agent/effects/usePermissionQueueEffects.ts 的接线逐字同形。
    clearForegroundPermissionRequestsForSession: (sessionId) =>
      useAppStore.getState().clearForegroundPermissionRequestsForSession(sessionId),
    removePermissionRequestsForBackgroundRun: (identity) =>
      useAppStore.getState().removePermissionRequestsForBackgroundRun(identity),
    debug: () => {},
    enqueuePermissionRequest: (sessionId, request, options) =>
      useAppStore.getState().enqueuePermissionRequest(sessionId, request, options),
    getCurrentSessionId: () => currentSessionId,
    hasPermissionRequest: (requestId) => {
      const state = useAppStore.getState();
      if (state.pendingPermissionRequest?.id === requestId) return true;
      return Object.values(state.queuedPermissionRequests)
        .some((queue) => queue.some((request) => request.id === requestId));
    },
    getPendingPermissionRequest: () => useAppStore.getState().pendingPermissionRequest,
    markSessionUnread: (sessionId) => {
      unreadSessionIds.push(sessionId);
    },
    now: () => 500,
    setLastEventAt: () => {},
    setPendingPermissionRequest: (request, sessionId) =>
      useAppStore.getState().setPendingPermissionRequest(request, sessionId),
    recordPermissionDecision: useAppStore.getState().recordPermissionDecision,
    dismissPermissionRequest: useAppStore.getState().dismissPermissionRequest,
  };
  return { deps, unreadSessionIds };
}

describe('后台任务审批卡在前台 run 结束后保留（N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO）', () => {
  beforeEach(() => {
    useAppStore.setState({
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {},
      resolvedPermissionRequests: {},
    });
  });

  it('前台 agent_complete 后，正显示着（pending）的后台审批卡仍在，可被批准', () => {
    const { deps } = createProductionDeps('session-main');
    const bgRequest = backgroundPermissionRequest('bg-write');

    // 后台任务在用户停留在主会话时请求审批 → 直接上卡（现有 enqueue 规则）。
    applyPermissionQueueEvent(
      { type: 'permission_request', data: bgRequest, sessionId: 'session-main' },
      deps,
    );
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('bg-write');
    expect(useAppStore.getState().pendingPermissionSessionId).toBe('session-main');

    // 前台 run 正常结束：同 sessionId 的 agent_complete。
    applyPermissionQueueEvent({ type: 'agent_complete', data: null, sessionId: 'session-main' }, deps);

    // 卡必须还在主会话里等着被点。
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('bg-write');
    expect(useAppStore.getState().pendingPermissionSessionId).toBe('session-main');

    // 卡是可动作的：批准（PermissionCard 点击的 store 侧效果）把卡收走并落已决存证。
    const pending = useAppStore.getState().pendingPermissionRequest;
    if (!pending) throw new Error('background approval card was not pending');
    useAppStore.getState().recordPermissionDecision(pending, 'once', 'session-main');
    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
    expect(useAppStore.getState().resolvedPermissionRequests['session-main']?.[0]?.id).toBe('bg-write');
  });

  it('用户在别的会话时：后台审批进队列并标未读，前台 run 结束后队列里的卡保留', () => {
    const { deps, unreadSessionIds } = createProductionDeps('session-other');
    const bgRequest = backgroundPermissionRequest('bg-queued');

    applyPermissionQueueEvent(
      { type: 'permission_request', data: bgRequest, sessionId: 'session-main' },
      deps,
    );
    expect(useAppStore.getState().queuedPermissionRequests['session-main']?.map((r) => r.id)).toEqual(['bg-queued']);
    expect(unreadSessionIds).toEqual(['session-main']);

    applyPermissionQueueEvent({ type: 'agent_complete', data: null, sessionId: 'session-main' }, deps);

    // 队列里的后台卡保留：用户切回主会话时 reconcile 会把它晋升成 pending（现有机制）。
    expect(useAppStore.getState().queuedPermissionRequests['session-main']?.map((r) => r.id)).toEqual(['bg-queued']);
  });

  it('error / stream_end 终态事件同样不清后台审批卡', () => {
    const { deps } = createProductionDeps('session-main');
    const bgRequest = backgroundPermissionRequest('bg-error-case');
    applyPermissionQueueEvent(
      { type: 'permission_request', data: bgRequest, sessionId: 'session-main' },
      deps,
    );

    applyPermissionQueueEvent(
      { type: 'error', data: { message: 'tool failed' }, sessionId: 'session-main' },
      deps,
    );
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('bg-error-case');

    applyPermissionQueueEvent({ type: 'stream_end', data: null, sessionId: 'session-main' }, deps);
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('bg-error-case');
  });

  it('没有 run 身份的前台请求仍按原样在 run 结束时被清掉', () => {
    const { deps } = createProductionDeps('session-main');
    const foregroundRequest = permissionRequest('fg-echo');
    applyPermissionQueueEvent(
      { type: 'permission_request', data: { ...foregroundRequest, sessionId: 'session-main' }, sessionId: 'session-main' },
      deps,
    );
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('fg-echo');

    applyPermissionQueueEvent({ type: 'agent_complete', data: null, sessionId: 'session-main' }, deps);

    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
    expect(useAppStore.getState().pendingPermissionSessionId).toBeNull();
  });
});

describe('后台子代理 Browser upload_file 审批卡在前台 run 结束后保留（N-SUBAGENT-APPROVAL-BUBBLE-UP-CARD-REPRO-FU2-BROWSER）', () => {
  beforeEach(() => {
    useAppStore.setState({
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {},
      resolvedPermissionRequests: {},
    });
  });

  /** requestBrowserUploadApproval 的请求形状 + subagentToolRuntime 摊进来的 lane 身份。 */
  function browserUploadRequest(id: string): PermissionRequest {
    return {
      id,
      type: 'file_read',
      tool: 'browser_action.upload_file',
      forceConfirm: true,
      dangerLevel: 'warning',
      details: { file: '.../invoice.pdf', action: 'upload_file', engine: 'managed', approvalMode: 'host_one_time_exact_file' },
      timestamp: 100,
      sessionId: 'session-main',
      agentId: `bg-agent-${id}`,
      runId: `bg-run-${id}`,
    } as PermissionRequest;
  }

  it('前台 agent_complete 后卡仍在 pending，批准把卡收走并落已决存证', () => {
    const { deps } = createProductionDeps('session-main');
    applyPermissionQueueEvent(
      { type: 'permission_request', data: browserUploadRequest('bg-upload-ok'), sessionId: 'session-main' },
      deps,
    );
    expect(useAppStore.getState().pendingPermissionRequest?.tool).toBe('browser_action.upload_file');

    applyPermissionQueueEvent({ type: 'agent_complete', data: null, sessionId: 'session-main' }, deps);
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('bg-upload-ok');

    const pending = useAppStore.getState().pendingPermissionRequest;
    if (!pending) throw new Error('browser upload card was not pending');
    useAppStore.getState().recordPermissionDecision(pending, 'once', 'session-main');
    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
    expect(useAppStore.getState().resolvedPermissionRequests['session-main']?.[0]?.id).toBe('bg-upload-ok');
  });

  it('前台 agent_complete 后卡仍在，拒绝同样把卡收走并落已决存证', () => {
    const { deps } = createProductionDeps('session-main');
    applyPermissionQueueEvent(
      { type: 'permission_request', data: browserUploadRequest('bg-upload-no'), sessionId: 'session-main' },
      deps,
    );
    applyPermissionQueueEvent({ type: 'agent_complete', data: null, sessionId: 'session-main' }, deps);
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('bg-upload-no');

    const pending = useAppStore.getState().pendingPermissionRequest;
    if (!pending) throw new Error('browser upload card was not pending');
    useAppStore.getState().recordPermissionDecision(pending, 'deny', 'session-main');
    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
    expect(useAppStore.getState().resolvedPermissionRequests['session-main']?.[0]?.id).toBe('bg-upload-no');
  });

  it('用户在别的会话时：Browser 上传审批进队列，前台 run 结束后保留', () => {
    const { deps } = createProductionDeps('session-other');
    applyPermissionQueueEvent(
      { type: 'permission_request', data: browserUploadRequest('bg-upload-q'), sessionId: 'session-main' },
      deps,
    );
    applyPermissionQueueEvent({ type: 'agent_complete', data: null, sessionId: 'session-main' }, deps);
    expect(useAppStore.getState().queuedPermissionRequests['session-main']?.map((r) => r.id)).toEqual(['bg-upload-q']);
  });
});

describe('后台任务自己的 run 结束 → 卡收走（stale-card guard）', () => {
  beforeEach(() => {
    useAppStore.setState({
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {},
      resolvedPermissionRequests: {},
    });
  });

  it.each([
    ['completed'],
    ['cancelled'],
    ['failed'],
  ] as const)('subagent_run_end(%s) 收掉该后台 lane 的 pending 与队列卡', (status) => {
    const { deps } = createProductionDeps('session-main');
    const pendingBg = backgroundPermissionRequest('bg-pending');
    // 同一条后台 lane 先后抛的两张卡：一张在 pending 槽、一张在队列里。
    const queuedBg: PermissionRequest = {
      ...backgroundPermissionRequest('bg-queued'),
      agentId: pendingBg.agentId,
      runId: pendingBg.runId,
    };
    const otherBg = backgroundPermissionRequest('bg-other-lane');
    applyPermissionQueueEvent(
      { type: 'permission_request', data: pendingBg, sessionId: 'session-main' },
      deps,
    );
    useAppStore.getState().enqueuePermissionRequest('session-main', queuedBg);
    useAppStore.getState().enqueuePermissionRequest('session-main', otherBg);

    applyPermissionQueueEvent({
      type: 'subagent_run_end',
      data: { agentId: pendingBg.agentId, runId: pendingBg.runId, status },
      sessionId: 'session-main',
    }, deps);

    // 同一 lane（agentId 匹配）的卡全收；别的 lane 不受牵连。
    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
    expect(useAppStore.getState().queuedPermissionRequests['session-main']?.map((r) => r.id))
      .toEqual(['bg-other-lane']);
  });

  it('companion 在别处裁决 → 桌面卡收走（既有语义，回归钉住）', () => {
    const { deps } = createProductionDeps('session-main');
    const bgRequest = backgroundPermissionRequest('bg-companion');
    applyPermissionQueueEvent(
      { type: 'permission_request', data: bgRequest, sessionId: 'session-main' },
      deps,
    );
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('bg-companion');

    applyPermissionQueueEvent({
      type: 'permission_request',
      data: { ...bgRequest, resolved: true, decision: 'once', resolvedBy: 'companion' },
      sessionId: 'session-main',
    }, deps);

    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
    expect(useAppStore.getState().resolvedPermissionRequests['session-main']).toBeUndefined();
  });

  it('宿主整岛 drain（取消/断连/新消息）发出的 resolved permission_request 收掉后台卡且不进本机已决存证', () => {
    const { deps } = createProductionDeps('session-main');
    const bgPending = backgroundPermissionRequest('bg-drained-pending');
    const bgQueued = backgroundPermissionRequest('bg-drained-queued');
    applyPermissionQueueEvent(
      { type: 'permission_request', data: bgPending, sessionId: 'session-main' },
      deps,
    );
    applyPermissionQueueEvent(
      { type: 'permission_request', data: bgQueued, sessionId: 'session-main' },
      deps,
    );
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('bg-drained-pending');
    expect(useAppStore.getState().queuedPermissionRequests['session-main']?.map((r) => r.id)).toEqual(['bg-drained-queued']);

    // 宿主 drain 对每条被解除的请求发出 { ...request, resolved: true }（无 decision）
    applyPermissionQueueEvent(
      { type: 'permission_request', data: { ...bgPending, resolved: true }, sessionId: 'session-main' },
      deps,
    );
    applyPermissionQueueEvent(
      { type: 'permission_request', data: { ...bgQueued, resolved: true }, sessionId: 'session-main' },
      deps,
    );

    // 即使随后到达 agent_cancelled，后台卡也早已被 dismiss 收掉，不留死卡，也不记进本机已决存证。
    applyPermissionQueueEvent({ type: 'agent_cancelled', data: null, sessionId: 'session-main' }, deps);

    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
    expect(useAppStore.getState().queuedPermissionRequests['session-main']).toBeUndefined();
    expect(useAppStore.getState().resolvedPermissionRequests['session-main']).toBeUndefined();
  });
});


describe('three sibling approvals share their parent runId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue({ outcome: 'delivered' });
    useAppStore.setState({
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {},
      resolvedPermissionRequests: {},
    });
  });

  afterEach(() => {
    cleanup();
    for (const id of ['A', 'B', 'C']) releaseApprovalResponse(id);
  });

  function enqueueSiblings() {
    const { deps } = createProductionDeps('session-main');
    const requests = ['A', 'B', 'C'].map(backgroundPermissionRequest);
    for (const request of requests) {
      applyPermissionQueueEvent({ type: 'permission_request', data: request, sessionId: 'session-main' }, deps);
    }
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('A');
    expect(useAppStore.getState().queuedPermissionRequests['session-main']?.map(r => r.id)).toEqual(['B', 'C']);
    return { deps, requests };
  }

  function reconcile() {
    reconcilePermissionQueue({ ...useAppStore.getState(), currentSessionId: 'session-main' });
  }

  function liveIds() {
    const state = useAppStore.getState();
    return [state.pendingPermissionRequest, ...(state.queuedPermissionRequests['session-main'] || [])]
      .filter((request): request is PermissionRequest => request !== null).map(r => r.id);
  }

  it('B ends: its queued card is removed and pending A / queued C stay in order', () => {
    const { deps, requests } = enqueueSiblings();
    applyPermissionQueueEvent({ type: 'subagent_run_end', data: { ...requests[1], status: 'completed' }, sessionId: 'session-main' }, deps);
    expect(liveIds()).toEqual(['A', 'C']);
    expect(useAppStore.getState().resolvedPermissionRequests).toEqual({});
    reconcile();
    expect(useAppStore.getState().pendingPermissionRequest?.id).toBe('A');
  });

  it.each([
    { name: 'all approved', order: ['B', 'A', 'C'], decisions: ['once', 'once', 'once'] },
    { name: 'approve / deny / approve', order: ['B', 'A', 'C'], decisions: ['once', 'deny', 'once'] },
    { name: 'out-of-order C / A / B', order: ['C', 'A', 'B'], decisions: ['once', 'once', 'once'] },
  ] as const)('$name: every click records its own requestId', async ({ order, decisions }) => {
    const { deps, requests } = enqueueSiblings();
    for (const [index, id] of order.entries()) {
      const request = requests.find(r => r.id === id)!;
      const decision = decisions[index];
      expect(liveIds()).toContain(id);
      // DecisionSlot renders queued cards via requestOverride as well as the pending card.
      const view = render(createElement<PermissionCardProps>(PermissionCard, { requestOverride: request, sessionIdOverride: 'session-main' }));
      fireEvent.click(screen.getByRole('button', { name: decision === 'deny' ? /^拒绝/ : /允许一次/ }));
      await waitFor(() => {
        expect(useAppStore.getState().resolvedPermissionRequests['session-main']?.map(r => [r.id, r.decision]))
          .toEqual(order.slice(0, index + 1).map((requestId, n) => [requestId, decisions[n]]));
      });
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, id, decision === 'deny' ? 'deny' : 'allow', 'session-main');
      view.unmount();
      applyPermissionQueueEvent({ type: 'subagent_run_end', data: { agentId: request.agentId, runId: request.runId, status: 'completed' }, sessionId: 'session-main' }, deps);
      reconcile();
      expect(liveIds()).toEqual((['A', 'B', 'C'] as const).filter(other => !order.slice(0, index + 1).includes(other)));
    }
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('stale click retires only that card and shows the human message without recording a local decision', async () => {
    const { requests } = enqueueSiblings();
    invoke.mockResolvedValueOnce({ outcome: 'unknown_request' });
    render(createElement<PermissionCardProps>(PermissionCard, { requestOverride: requests[0], sessionIdOverride: 'session-main' }));
    fireEvent.click(screen.getByRole('button', { name: /允许一次/ }));
    await waitFor(() => {
      expect(liveIds()).toEqual(['B', 'C']);
      expect(toastError).toHaveBeenCalledWith(zh.decisionCard.permission.settledElsewhere);
    });
    expect(zh.decisionCard.permission.settledElsewhere).toBeTruthy();
    // stale 不一定是超时（手机先答、工具已跑）：只收卡，不把别处的结局记成本机决定
    expect(useAppStore.getState().resolvedPermissionRequests).toEqual({});
  });

  it('sidebar waiting status follows the same store as the cards: shown while any sibling card is live, gone after the last', () => {
    const { deps, requests } = enqueueSiblings();
    const waiting = () => {
      const { pendingPermissionRequest, pendingPermissionSessionId, queuedPermissionRequests } = useAppStore.getState();
      return getSessionWaitingDetail('session-main', { permissionState: { pendingPermissionRequest, pendingPermissionSessionId, queuedPermissionRequests } });
    };
    for (const request of requests) {
      expect(waiting()).toEqual({ kind: 'permission' });
      expect(liveIds().length).toBeGreaterThan(0);
      applyPermissionQueueEvent({ type: 'subagent_run_end', data: { agentId: request.agentId, runId: request.runId, status: 'completed' }, sessionId: 'session-main' }, deps);
    }
    expect(liveIds()).toEqual([]);
    expect(waiting()).toBeUndefined();
  });

  it.each([
    { requestAgent: undefined, eventAgent: 'delegate-agent' },
    { requestAgent: 'delegate-agent', eventAgent: undefined },
    { requestAgent: undefined, eventAgent: undefined },
  ])('falls back to runId when either side lacks agentId: %o', ({ requestAgent, eventAgent }) => {
    const { deps } = createProductionDeps('session-main');
    const ended = { ...backgroundPermissionRequest('delegate'), agentId: requestAgent };
    const other = { ...backgroundPermissionRequest('other-run'), runId: 'independent-run' };
    for (const request of [ended, other]) {
      applyPermissionQueueEvent({ type: 'permission_request', data: request, sessionId: 'session-main' }, deps);
    }
    applyPermissionQueueEvent({ type: 'subagent_run_end', data: { agentId: eventAgent, runId: ended.runId, status: 'completed' }, sessionId: 'session-main' }, deps);
    expect(liveIds()).toEqual(['other-run']);
  });

  it('agentId identifies the lane even when runId differs; empty identity removes nothing', () => {
    const { deps, requests } = enqueueSiblings();
    applyPermissionQueueEvent({ type: 'subagent_run_end', data: { status: 'completed' }, sessionId: 'session-main' }, deps);
    expect(liveIds()).toEqual(['A', 'B', 'C']);
    applyPermissionQueueEvent({ type: 'subagent_run_end', data: { agentId: requests[0].agentId, runId: 'another-run', status: 'completed' }, sessionId: 'session-main' }, deps);
    expect(liveIds()).toEqual(['B', 'C']);
  });
});
