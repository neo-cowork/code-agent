import { useCallback } from 'react';
import type { StreamInterruptionReason, ToolCall } from '@shared/contract';
import { useAppStore } from '../stores/appStore';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { isToolCallAwaitingApproval } from '../utils/sessionNeedsInput';
import { resolveToolCallTerminalState } from '../utils/toolCallTerminalState';
import { useSessionAgentRows } from './useSessionAgentRows';

export function useToolCallTerminalResolver(sessionId: string | null | undefined) {
  const tasks = useBackgroundTaskStore(state => state.tasks);
  const { rows } = useSessionAgentRows(sessionId ?? null);
  const live = useAppStore(state => Boolean(sessionId && state.processingSessionIds.has(sessionId)));
  const pendingPermissionRequest = useAppStore(state => state.pendingPermissionRequest);
  const pendingPermissionSessionId = useAppStore(state => state.pendingPermissionSessionId);
  const queuedPermissionRequests = useAppStore(state => state.queuedPermissionRequests);
  return useCallback((toolCall: ToolCall, interruptionReason?: StreamInterruptionReason, agentId?: string, sessionLive?: boolean) =>
    resolveToolCallTerminalState({ toolCall, sessionId, tasks, agentRows: rows, agentId, sessionLive: sessionLive ?? live,
      interruptionReason, awaitingApproval: isToolCallAwaitingApproval(toolCall.id, sessionId, {
        pendingPermissionRequest, pendingPermissionSessionId, queuedPermissionRequests,
      }) }), [sessionId, tasks, rows, live, pendingPermissionRequest, pendingPermissionSessionId, queuedPermissionRequests]);
}
