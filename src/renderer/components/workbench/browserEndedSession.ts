import { selectSurfaceExecutionRunSessionV1 } from '../../stores/surfaceExecutionStore';
import { isUserOpenedSurfaceV1, type RendererSurfaceSessionProjectionV1 } from '../../utils/surfaceExecutionProjection';

/** Select display history only; this does not restore, resume, or control a browser. */
export function selectBrowserEndedSession(
  sessions: Record<string, RendererSurfaceSessionProjectionV1>,
  conversationId: string | null,
  activeSessionId: string | null,
  managedUrl: string | undefined,
  previous: RendererSurfaceSessionProjectionV1 | null,
): RendererSurfaceSessionProjectionV1 | null {
  const display = selectSurfaceExecutionRunSessionV1(sessions, { conversationId });
  if (display?.session.surface !== 'browser') return null;
  if (!activeSessionId && (display.session.state === 'completed' || display.session.state === 'failed')) return display;
  if (managedUrl && managedUrl !== 'about:blank') return null;
  const persisted = display.source === 'persisted' && !display.writable && managedUrl === 'about:blank';
  // A persisted running state describes the pre-crash process. Opening its panel
  // can create a targetless user-browser placeholder whose snapshot replaces history.
  if (!persisted && !isUserOpenedSurfaceV1(display)) return null;
  const target = display.session.activeTarget;
  if (!persisted && target?.kind === 'browser' && target.origin) return null;
  const agent = selectSurfaceExecutionRunSessionV1(sessions, { conversationId, excludeUserOpened: true });
  if (agent?.source === 'live' && agent.writable
    && agent.session.state !== 'completed' && agent.session.state !== 'failed') return null;
  const archived = Object.fromEntries(Object.entries(sessions).filter(([, candidate]) => (
    candidate.session.surface === 'browser' && candidate.source === 'persisted' && !candidate.writable
    && candidate.session.activeTarget?.kind === 'browser' && candidate.session.activeTarget.origin
  )));
  // Retain only the already displayed read-only history, scoped to this conversation.
  if (previous?.scope.conversationId === conversationId && previous.source === 'persisted' && !previous.writable) {
    archived[previous.session.sessionId] ??= previous;
  }
  return selectSurfaceExecutionRunSessionV1(archived, { conversationId }) ?? (persisted ? display : null);
}
