import { createHash } from 'node:crypto';
import type {
  ComputerUseExpectationV1,
  ComputerUseStateViewV1,
} from '../../../shared/contract/desktop';
import type {
  InteractiveSurfaceSessionV1,
  SurfaceExecutionEventV1,
  SurfaceExpectationV1,
  SurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';
import type { CuaInputLockLifecycleEvent } from '../../mcp/cuaSessionLock';
import { beginApprovalWait, endApprovalWait } from '../../tools/toolExecutionTelemetry';
import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import { waitForSurfaceHumanTakeoverRelease } from './browserHumanTakeoverWait';
import type { SurfaceEventHub } from './SurfaceEventHub';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';
import type { SurfaceSessionManager } from './SurfaceSessionManager';
import { subjectFor } from './surfaceRuntimeHelpers';

export function computerTargetFromState(
  state: ComputerUseStateViewV1,
  metadata: { providerGeneration: string; providerSnapshotId: string },
): Extract<SurfaceTargetRefV1, { kind: 'computer' }> {
  const appName = state.root.appName?.trim();
  if (!appName) {
    throw new Error('Computer observation requires a verified application identity.');
  }
  const windowRef = `cua-window:${createHash('sha256')
    .update(JSON.stringify([state.root.provider, state.root.pid, state.root.windowId]))
    .digest('hex')
    .slice(0, 24)}`;
  const windowRevision = createHash('sha256')
    .update(JSON.stringify([
      metadata.providerGeneration,
      metadata.providerSnapshotId,
      state.hostRevision,
    ]))
    .digest('hex')
    .slice(0, 32);
  return {
    kind: 'computer',
    deviceId: 'local',
    appName,
    pid: state.root.pid,
    windowRef,
    windowRevision,
    ...(state.root.title ? { title: state.root.title } : {}),
  };
}

export function computerExpectationToSurface(
  expectation: ComputerUseExpectationV1,
): SurfaceExpectationV1 {
  if (expectation.kind === 'element_exists' || expectation.kind === 'element_absent') {
    return { kind: expectation.kind, elementRef: expectation.elementRef || '' };
  }
  if (expectation.kind === 'text_present') {
    return { kind: 'text_present', text: expectation.text || '' };
  }
  if (expectation.kind === 'window_present') {
    return { kind: 'window_present' };
  }
  return {
    kind: 'custom',
    description: `element ${expectation.elementRef || ''} value equals expected value`,
  };
}

export function recordComputerInputLockLifecycleEvent(input: {
  sessions: SurfaceSessionManager;
  events: SurfaceEventHub;
  subject: SurfaceGrantSubjectV1;
  lifecycle: CuaInputLockLifecycleEvent;
}): SurfaceExecutionEventV1 {
  const session = input.sessions.requireOwned(input.subject.sessionId, input.subject);
  if (session.surface !== 'computer'
    || session.provider !== 'cua-driver'
    || input.lifecycle.scope !== session.sessionId) {
    throw new SurfaceExecutionRuntimeError({
      code: 'SURFACE_TARGET_NOT_OWNED',
      message: 'Computer input lock event does not match the owning Surface session.',
      phase: input.lifecycle.phase === 'release'
        ? 'cleanup'
        : input.lifecycle.phase === 'recover' ? 'recover' : 'prepare',
      recommendedAction: 'Publish lock lifecycle only for the owning Computer Surface session.',
      surface: 'computer',
      provider: session.provider,
      sessionId: session.sessionId,
    });
  }
  const succeeded = input.lifecycle.status === 'succeeded';
  const terminalSession = session.state === 'completed' || session.state === 'failed';
  const phase = input.lifecycle.phase === 'release'
    ? 'cleanup' as const
    : input.lifecycle.phase === 'recover' ? 'recover' as const : 'prepare' as const;
  return input.events.publish(input.subject, {
    phase,
    status: input.lifecycle.status,
    userSummary: computerInputLockSummary(input.lifecycle),
    operation: {
      action: `computer_input_lock_${input.lifecycle.phase}`,
      risk: 'input',
      approvalScope: 'surface-session',
    },
    observation: {
      verdict: succeeded ? 'pass' : 'fail',
      findings: [],
    },
    evidenceRefs: [],
    artifactRefs: [],
    availableControls: terminalSession
      ? []
      : succeeded
        ? ['pause', 'takeover', 'stop', 'end_session']
        : ['stop', 'end_session'],
    startedAt: input.lifecycle.occurredAt,
    completedAt: input.lifecycle.occurredAt,
  });
}

function computerInputLockSummary(event: CuaInputLockLifecycleEvent): string {
  if (event.phase === 'recover') {
    return event.status === 'succeeded'
      ? 'Recovered stale Computer input ownership'
      : 'Computer input ownership recovery failed';
  }
  if (event.phase === 'release') {
    if (event.outcome === 'already_released') return 'Computer input ownership was already released';
    return event.status === 'succeeded'
      ? 'Computer input ownership released'
      : 'Computer input ownership release was rejected';
  }
  if (event.outcome === 'reentrant') return 'Computer input ownership refreshed';
  return event.status === 'succeeded'
    ? 'Computer input ownership acquired'
    : 'Computer input ownership is unavailable';
}

export async function awaitComputerHumanTakeoverRelease(input: {
  sessions: SurfaceSessionManager;
  subject: SurfaceGrantSubjectV1;
  conversationId: string;
  operationId: string;
  toolCallId?: string;
  parentSignal?: AbortSignal;
}): Promise<InteractiveSurfaceSessionV1> {
  beginApprovalWait(input.toolCallId, input.conversationId);
  try {
    return await waitForSurfaceHumanTakeoverRelease({
      readSession: () => input.sessions.requireOwned(input.subject.sessionId, input.subject),
      operationId: input.operationId,
      ...(input.parentSignal ? { parentSignal: input.parentSignal } : {}),
    });
  } finally {
    endApprovalWait(input.toolCallId, input.conversationId);
  }
}

export function findActiveOwnedComputerSession(
  sessions: SurfaceSessionManager,
  identity: { conversationId: string; runId: string; agentId: string },
  provider = 'cua-driver',
): InteractiveSurfaceSessionV1 | null {
  return sessions.findActive({
    conversationId: identity.conversationId,
    runId: identity.runId,
    agentId: identity.agentId,
    surface: 'computer',
    provider,
  }) ?? null;
}

export async function awaitOwnedComputerSessionReady(input: {
  sessions: SurfaceSessionManager;
  identity: { conversationId: string; runId: string; agentId: string };
  operationId: string;
  provider?: string;
  toolCallId?: string;
  parentSignal?: AbortSignal;
}): Promise<InteractiveSurfaceSessionV1 | null> {
  const session = findActiveOwnedComputerSession(input.sessions, input.identity, input.provider);
  if (session?.state !== 'waiting_human') return session;
  return awaitComputerHumanTakeoverRelease({
    sessions: input.sessions,
    subject: subjectFor(session),
    conversationId: input.identity.conversationId,
    operationId: input.operationId,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.parentSignal ? { parentSignal: input.parentSignal } : {}),
  });
}
