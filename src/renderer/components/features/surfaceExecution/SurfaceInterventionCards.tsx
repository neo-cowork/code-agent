import React from 'react';
import type { RendererSurfaceSessionProjectionV1 } from '../../../utils/surfaceExecutionProjection';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';
import { selectBrowserWaitForUserV1 } from '../../../utils/surfaceExecutionProjection';
import { Button } from '../../primitives';
import type { SurfaceExecutionControlHandlerV1 } from './types';
import { latestSurfaceEvent, safeSurfaceText, surfaceControlActions } from './surfaceExecutionPresentation';

interface SurfaceInterventionCardProps {
  session: RendererSurfaceSessionProjectionV1;
  copy: SurfaceExecutionTranslationsV1;
  onControl?: SurfaceExecutionControlHandlerV1;
}

export function SurfaceHumanTakeoverCard({ session, copy, onControl }: SurfaceInterventionCardProps) {
  const [pending, setPending] = React.useState(false);
  const event = latestSurfaceEvent(session);
  const waitForUser = selectBrowserWaitForUserV1(session);
  const detail = waitForUser
    ? safeSurfaceText(waitForUser.reason, copy.takeover.description, 180)
    : event?.phase === 'human'
      ? safeSurfaceText(event.userSummary, copy.takeover.description, 180)
      : copy.takeover.description;
  const title = waitForUser
    ? (waitForUser.timedOut ? copy.takeover.stoppedTitle : copy.takeover.waitingTitle)
    : copy.takeover.title;
  // Same resume control the live-view bar sends: the chat card is enough to finish the handover.
  const canDone = Boolean(waitForUser && onControl && surfaceControlActions(session).includes('resume'));

  return (
    <section
      data-testid="surface-human-takeover-card"
      className="rounded-lg border border-badge-accent/20 bg-violet-400/[0.05] p-3"
    >
      <h4 className="text-[11px] font-medium text-badge-accent">{title}</h4>
      <p className="mt-1 text-[10px] leading-4 text-badge-accent/60">{detail}</p>
      {canDone && (
        <Button
          type="button"
          variant="primary"
          size="sm"
          data-testid="surface-human-takeover-done"
          disabled={pending}
          className="mt-2"
          onClick={() => {
            if (!onControl || pending) return;
            setPending(true);
            void Promise.resolve(onControl({
              version: 1,
              conversationId: session.scope.conversationId,
              surfaceSessionId: session.scope.surfaceSessionId,
              action: 'resume',
            })).catch(() => undefined).finally(() => setPending(false));
          }}
        >
          {copy.takeover.done}
        </Button>
      )}
    </section>
  );
}

export function SurfaceRecoveryCard({ session, copy }: SurfaceInterventionCardProps) {
  const event = latestSurfaceEvent(session);
  const detail = event?.phase === 'recover'
    ? safeSurfaceText(event.userSummary, copy.recovery.description, 180)
    : copy.recovery.description;

  return (
    <section
      data-testid="surface-recovery-card"
      className="rounded-lg border border-badge-warning/20 bg-amber-400/[0.05] p-3"
    >
      <h4 className="text-[11px] font-medium text-badge-warning">{copy.recovery.title}</h4>
      <p className="mt-1 text-[10px] leading-4 text-badge-warning/60">{detail}</p>
    </section>
  );
}
