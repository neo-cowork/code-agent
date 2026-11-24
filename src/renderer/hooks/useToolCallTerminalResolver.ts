import { useCallback, useEffect, useMemo, useState } from 'react';
import { APPROVAL_ANSWER_RESULT_GRACE_MS } from '@shared/constants';
import type { StreamInterruptionReason, ToolCall } from '@shared/contract';
import { useAppStore } from '../stores/appStore';
import { useParkedToolCallIds } from '../stores/parkedApprovalStore';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { isToolCallAwaitingApproval } from '../utils/sessionNeedsInput';
import { resolveToolCallTerminalState, toolCallNeedsAgentRows } from '../utils/toolCallTerminalState';
import { useAgentTreeSnapshot } from './useAgentTreeSnapshot';
import { buildAgentRows } from '../utils/agentRows';

export function useToolCallTerminalResolver(
  sessionId: string | null | undefined,
  calls: readonly { toolCall?: ToolCall; agentId?: string }[],
) {
  const tasks = useBackgroundTaskStore(state => state.tasks);
  // Same session-scoped snapshot and row builder as useSessionAgentRows, without
  // pulling the member bar's recipe/preselection UI into every historical tool row.
  // Settled history never subscribes: only a call an agent row could still settle does.
  const needsAgentRows = Boolean(sessionId) && calls.some(call => toolCallNeedsAgentRows({ ...call, sessionId, tasks }));
  const { snapshot } = useAgentTreeSnapshot(sessionId ?? null, needsAgentRows);
  const rows = useMemo(() => {
    const nodes = sessionId ? (snapshot?.nodes ?? []).filter(node => node.sources.some(source =>
      source !== 'parallelCoordinator' && source !== 'agentWorktree')) : [];
    return nodes.length ? buildAgentRows({ members: [], tasks: [], nodes }) : [];
  }, [sessionId, snapshot]);
  const live = useAppStore(state => Boolean(sessionId && state.processingSessionIds.has(sessionId)));
  const pendingPermissionRequest = useAppStore(state => state.pendingPermissionRequest);
  const pendingPermissionSessionId = useAppStore(state => state.pendingPermissionSessionId);
  const queuedPermissionRequests = useAppStore(state => state.queuedPermissionRequests);
  const resolvedPermissionRequests = useAppStore(state => state.resolvedPermissionRequests);
  const answeredRequests = sessionId ? resolvedPermissionRequests?.[sessionId] : undefined;
  // 宽限到点要让行重算一次，否则没有任何状态变化去触发重渲染。
  const [graceTick, setGraceTick] = useState(0);
  useEffect(() => {
    const latest = Math.max(0, ...(answeredRequests ?? []).map(request => request.answeredAt ?? 0));
    const remaining = latest + APPROVAL_ANSWER_RESULT_GRACE_MS - Date.now();
    if (remaining <= 0) return undefined;
    const timer = setTimeout(() => setGraceTick(tick => tick + 1), remaining + 50);
    return () => clearTimeout(timer);
  }, [answeredRequests]);
  const parkedToolCallIdsBySession = useParkedToolCallIds(sessionId, calls.some(call => call.toolCall?.result === undefined));
  return useCallback((toolCall: ToolCall, interruptionReason?: StreamInterruptionReason, agentId?: string, sessionLive?: boolean,
    delegatedWork?: 'working' | 'completed' | 'failed' | 'cancelled') =>
    resolveToolCallTerminalState({ toolCall, sessionId, tasks, agentRows: rows, agentId, sessionLive: sessionLive ?? live,
      interruptionReason, delegatedWork,
      // 审批刚答完、结果还没到：旁观他端发起的 run 时本页收不到该 run 的 tool_result，不能因终态广播清了 live 就读成「已中断」。
      approvalAnswered: Boolean(answeredRequests?.some(request => request.parentToolUseId === toolCall.id
        && request.answeredAt !== undefined && Date.now() - request.answeredAt < APPROVAL_ANSWER_RESULT_GRACE_MS)),
      awaitingApproval: isToolCallAwaitingApproval(toolCall.id, sessionId, {
        pendingPermissionRequest, pendingPermissionSessionId, queuedPermissionRequests, parkedToolCallIdsBySession,
      }) }), [sessionId, tasks, rows, live, pendingPermissionRequest, pendingPermissionSessionId, queuedPermissionRequests, parkedToolCallIdsBySession, answeredRequests, graceTick]);
}
