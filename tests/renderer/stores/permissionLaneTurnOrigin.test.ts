// N-FIX-E2E-NIGHTLY-F05 r3：delegate_task 通道的审批请求没有顶层 runId/agentId，
// 只在 turnOrigin[0].runId 带后台任务 id（真抓包 reverse1/F05-a1.sse:160 的形状）。
// 前台 run 终态清理不得把它的卡当前台卡收走；任务自己收线、或任务已终态时仍要清。
import { beforeEach, describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';

const SESSION = 'session_1795620258475_6ed3b818';
const TASK_ID = 'session-work-1795620269709-p27kyd';

function laneRequest(): PermissionRequest {
  return {
    id: 'perm-99f466b0-24f8-4cd5-b5ee-0f269eab8b71',
    type: 'command',
    tool: 'Bash',
    details: { command: 'curl -L -sS https://example.com -o example.html; echo "exit=$?"' },
    sessionId: SESSION,
    parentToolUseId: 'call_2621f6b3973f4e45baa7a7c7',
    turnOrigin: [{ senderKind: 'user', sessionId: SESSION, runId: TASK_ID, turnId: '5c8eb83b' }],
    timestamp: 1795620273495,
  } as PermissionRequest;
}

function foregroundRequest(): PermissionRequest {
  return {
    ...laneRequest(),
    id: 'perm-foreground',
    turnOrigin: [{ senderKind: 'user', sessionId: SESSION, runId: 'run-foreground-1', turnId: 't1' }],
  };
}

function task(status: Task['status']): Task {
  return { id: TASK_ID, status, source: 'delegate', title: 't', createdAt: 1, updatedAt: 1, events: [], outputRefs: [] } as unknown as Task;
}

describe('foreground run-end cleanup vs delegate_task lane approval (turnOrigin only)', () => {
  beforeEach(() => {
    useAppStore.setState({ pendingPermissionRequest: null, pendingPermissionSessionId: null, queuedPermissionRequests: {} });
    useBackgroundTaskStore.setState({ tasks: [] });
  });

  it('keeps a pending lane card whose turnOrigin.runId is a live background task', () => {
    useBackgroundTaskStore.setState({ tasks: [task('running')] });
    const lane = laneRequest();
    useAppStore.setState({ pendingPermissionRequest: lane, pendingPermissionSessionId: SESSION });
    useAppStore.getState().clearForegroundPermissionRequestsForSession(SESSION);
    expect(useAppStore.getState().pendingPermissionRequest).toEqual(lane);
  });

  it('keeps a queued lane card too', () => {
    useBackgroundTaskStore.setState({ tasks: [task('running')] });
    const lane = laneRequest();
    useAppStore.setState({ queuedPermissionRequests: { [SESSION]: [lane] } });
    useAppStore.getState().clearForegroundPermissionRequestsForSession(SESSION);
    expect(useAppStore.getState().queuedPermissionRequests[SESSION]).toEqual([lane]);
  });

  it('still clears a foreground request (turnOrigin points at the foreground run)', () => {
    useBackgroundTaskStore.setState({ tasks: [task('running')] });
    useAppStore.setState({ pendingPermissionRequest: foregroundRequest(), pendingPermissionSessionId: SESSION });
    useAppStore.getState().clearForegroundPermissionRequestsForSession(SESSION);
    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
  });

  it('clears the card once the task is terminal', () => {
    useBackgroundTaskStore.setState({ tasks: [task('completed')] });
    useAppStore.setState({ pendingPermissionRequest: laneRequest(), pendingPermissionSessionId: SESSION });
    useAppStore.getState().clearForegroundPermissionRequestsForSession(SESSION);
    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
  });

  it('lane run end (subagent_run_end identity) removes the turnOrigin-only card', () => {
    useAppStore.setState({ pendingPermissionRequest: laneRequest(), pendingPermissionSessionId: SESSION });
    useAppStore.getState().removePermissionRequestsForBackgroundRun({ runId: TASK_ID, agentId: null });
    expect(useAppStore.getState().pendingPermissionRequest).toBeNull();
  });

  it('lane run end does not touch a foreground request', () => {
    const fg = foregroundRequest();
    useAppStore.setState({ pendingPermissionRequest: fg, pendingPermissionSessionId: SESSION });
    useAppStore.getState().removePermissionRequestsForBackgroundRun({ runId: TASK_ID, agentId: null });
    expect(useAppStore.getState().pendingPermissionRequest).toEqual(fg);
  });
});
