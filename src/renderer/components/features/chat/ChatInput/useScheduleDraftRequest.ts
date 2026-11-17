import { useEffect, useRef } from 'react';
import { ipcService } from '../../../../services/ipcService';

/** Only model events open a draft here; composer text always goes to the model. */
export function useScheduleDraftRequest(
  sessionId: string | null,
  creating: boolean,
  runScheduleCreation: (description: string) => Promise<boolean>,
): void {
  const latest = useRef({ sessionId, creating, runScheduleCreation });
  latest.current = { sessionId, creating, runScheduleCreation };
  const inFlight = useRef(false);
  useEffect(() => ipcService.on('agent:event', (event: { type: string; data: unknown }) => {
    if (event.type !== 'schedule_draft_requested' || !event.data) return;
    const data = event.data as { sessionId?: unknown; description?: unknown };
    const current = latest.current;
    if (!current.sessionId || data.sessionId !== current.sessionId || current.creating || inFlight.current) return;
    if (typeof data.description !== 'string' || !data.description.trim()) return;
    inFlight.current = true;
    void current.runScheduleCreation(data.description).finally(() => { inFlight.current = false; });
  }), []);
}
