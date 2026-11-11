import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { useSessionStore } from '../../../stores/sessionStore';
import { Button } from '../../primitives/Button';

export function SidebarSessionsUnavailable() {
  const { t } = useI18n();
  const loadSessions = useSessionStore((state) => state.loadSessions);
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center" data-testid="sidebar-sessions-unavailable">
      <p role="status" className="text-xs text-zinc-400">{t.sidebar.sessionsUnavailable}</p>
      <Button variant="secondary" onClick={() => void loadSessions()}>{t.sidebar.connectionRetry}</Button>
    </div>
  );
}
