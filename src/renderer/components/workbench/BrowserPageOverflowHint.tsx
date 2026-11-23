import React, { useContext } from 'react';
import type { SurfaceLiveFrameV1 } from '@shared/contract/surfaceExecution';
import { useI18n } from '../../hooks/useI18n';
import { useWorkbenchFocusStore } from '../../stores/workbenchFocusStore';
import { Button } from '../primitives/Button';
import { WorkbenchFocusAvailability } from './workbenchFocusAvailability';

export function BrowserPageOverflowHint({ frame, surfaceSessionId, conversationId }: {
  frame: SurfaceLiveFrameV1 | null;
  surfaceSessionId: string | null;
  conversationId: string | null;
}) {
  const focusable = useContext(WorkbenchFocusAvailability);
  const focused = useWorkbenchFocusStore((state) => state.workbenchFocused);
  const setFocused = useWorkbenchFocusStore((state) => state.setWorkbenchFocused);
  const { t } = useI18n();
  const copy = t.workbenchTabs;
  if (!focusable || focused || !surfaceSessionId || !conversationId
    || frame?.surfaceSessionId !== surfaceSessionId
    || frame.conversationId !== conversationId || frame.pageOverflowX !== true) return null;

  return (
    <div data-testid="browser-page-overflow-hint" role="status"
      className="flex shrink-0 items-center gap-2 border-t border-zinc-700 px-2 py-1 text-[11px] text-zinc-300">
      <span className="min-w-0 flex-1 truncate" title={copy.pageOverflowHint}>{copy.pageOverflowHint}</span>
      <Button size="sm" variant="secondary" className="shrink-0" onClick={() => setFocused(true)}>
        {copy.enlargePanel}
      </Button>
    </div>
  );
}
