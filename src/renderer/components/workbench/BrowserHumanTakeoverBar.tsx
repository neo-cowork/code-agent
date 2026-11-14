import React, { useMemo } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { resumeBrowserHumanTakeover } from '../../hooks/requestBrowserHumanTakeover';
import { useSessionStore } from '../../stores/sessionStore';
import {
  selectActiveBrowserSurfaceSessionV1,
  useSurfaceExecutionStore,
} from '../../stores/surfaceExecutionStore';
import { browserStageOverlayMarker } from '../../utils/browserStageInteractionGate';
import { isUserOpenedSurfaceV1, selectBrowserWaitForUserV1 } from '../../utils/surfaceExecutionProjection';
import { Button } from '../primitives';

/**
 * Live-view bar while the agent browser session is waiting_human.
 * Neo asked for the user (wait_for_user): shows its reason + Done; the user's own takeover keeps the pause hint.
 * Hidden for a page the user opened themselves.
 * Pure chrome: pointer/click pass-through is blocked by the stage input gate
 * via the overlay marker, not by handlers on this element.
 */
export const BrowserHumanTakeoverBar: React.FC = () => {
  const { t } = useI18n();
  const copy = t.workbenchTabs.agentWindow;
  const conversationId = useSessionStore((state) => state.currentSessionId);
  const sessionsByScope = useSurfaceExecutionStore((state) => state.sessionsByScope);
  // The page the user opened in the rail is a second browser session in the same conversation and
  // is often the newest; it must not hide the bar of the agent session that is waiting for the user.
  const activeBrowserSurface = useMemo(() => selectActiveBrowserSurfaceSessionV1(
    Object.fromEntries(Object.entries(sessionsByScope).filter(([, candidate]) => !isUserOpenedSurfaceV1(candidate))),
    conversationId,
  ), [sessionsByScope, conversationId]);
  if (activeBrowserSurface?.session.state !== 'waiting_human') {
    return null;
  }
  const surfaceSessionId = activeBrowserSurface.session.sessionId;
  const waitForUser = selectBrowserWaitForUserV1(activeBrowserSurface);
  const hint = waitForUser
    ? (waitForUser.timedOut ? copy.takeoverStoppedHint : copy.takeoverWaitingHint).replace('{reason}', waitForUser.reason)
    : copy.takeoverPausedHint;
  return (
    <div
      data-testid="browser-human-takeover-bar"
      {...browserStageOverlayMarker}
      className="absolute inset-x-3 bottom-3 z-30 flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-zinc-900/95 px-3 py-2"
    >
      <p className="min-w-0 text-xs text-zinc-200">{hint}</p>
      <Button
        variant="primary"
        size="sm"
        data-testid="browser-human-takeover-continue"
        onClick={() => {
          void resumeBrowserHumanTakeover({ conversationId, surfaceSessionId });
        }}
      >
        {waitForUser ? copy.takeoverDone : copy.takeoverContinue}
      </Button>
    </div>
  );
};
